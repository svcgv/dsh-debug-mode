/**
 * Minimal Debug Adapter Protocol client over a byte transport. Frames use the
 * standard Content-Length envelope; commands correlate by seq, events
 * dispatch to subscribers, and a stopped-wait helper is provided for stepping.
 *
 * @module dsh-debug-mode/runtime/dap
 */

export interface DapTransport {
  write(data: Buffer | string): void
  close(): void
}

interface Pending {
  readonly resolve: (body: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: NodeJS.Timeout
}

interface EventWaiter {
  readonly event: string
  readonly resolve: (body: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: NodeJS.Timeout
}

/** One DAP error response. */
export class DapError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message)
    this.name = 'DapError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Client for one debug adapter session. */
export class DapClient {
  private seq = 1
  private readonly pending = new Map<number, Pending>()
  private readonly waiters = new Set<EventWaiter>()
  private readonly listeners = new Set<(event: string, body: unknown) => void>()
  private buffer = ''
  private closed = false

  constructor(private readonly transport: DapTransport) {}

  /** Whether the transport has been closed. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Send one request and await its response body. */
  send(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('DAP transport is closed'))
    const seq = this.seq
    this.seq += 1
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`DAP command ${command} timed out`))
      }, 30_000)
      this.pending.set(seq, { resolve, reject, timer })
      this.write({ seq, type: 'request', command, arguments: args })
    })
  }

  /** Subscribe to every incoming event. */
  onEvent(listener: (event: string, body: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolve when an event with the given name arrives (or timeout). */
  waitForEvent(event: string, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error(`DAP event ${event} timed out`))
      }, timeoutMs)
      const waiter: EventWaiter = {
        event,
        resolve: (body) => {
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve(body)
        },
        reject,
        timer,
      }
      waiters.add(waiter)
    })
  }

  /** Feed raw bytes into the framing parser. */
  feed(chunk: Buffer | string): void {
    if (this.closed) return
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.slice(0, headerEnd)
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header)
      if (lengthMatch === null) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const length = Number(lengthMatch[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const raw = this.buffer.slice(bodyStart, bodyStart + length)
      this.buffer = this.buffer.slice(bodyStart + length)
      this.handleMessage(raw)
    }
  }

  /** Close the transport and reject anything waiting. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const reason = new Error('DAP transport closed')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(reason)
    }
    waiters.clear()
    this.listeners.clear()
    this.transport.close()
  }

  private write(message: Record<string, unknown>): void {
    const body = JSON.stringify(message)
    this.transport.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  private handleMessage(raw: string): void {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(message)) return
    const type = message.type
    if (type === 'response') {
      const requestSeq = message.request_seq
      const command = message.command
      if (typeof requestSeq !== 'number' || typeof command !== 'string') return
      const pending = this.pending.get(requestSeq)
      if (pending === undefined) return
      this.pending.delete(requestSeq)
      if (message.success !== true) {
        const errorMessage =
          isRecord(message.body) && typeof message.body.error === 'string'
            ? message.body.error
            : `DAP command ${command} failed`
        pending.reject(new DapError(errorMessage, command))
        return
      }
      pending.resolve(message.body)
      return
    }
    if (type === 'event') {
      const event = message.event
      if (typeof event !== 'string') return
      const body = message.body
      for (const listener of this.listeners) listener(event, body)
      for (const waiter of waiters) {
        if (waiter.event === event) waiter.resolve(body)
      }
    }
  }
}

const waiters = new Set<EventWaiter>()
