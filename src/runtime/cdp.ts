/**
 * Minimal Chrome DevTools Protocol client over a WebSocket. Commands are
 * correlated by id and awaited; events dispatch to subscribers. The socket is
 * injected so protocol behavior is unit-testable without a live process.
 *
 * @module dsh-debug-mode/runtime/cdp
 */

/** Socket surface the client needs. */
export interface CdpSocket {
  send(data: string): void
  close(): void
}

interface Pending {
  readonly command: string
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: NodeJS.Timeout
}

interface EventWaiter {
  readonly method: string
  readonly resolve: (params: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: NodeJS.Timeout
}

/** One CDP error response. */
export class CdpError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
    this.name = 'CdpError'
  }
}

/** Client for one debugger websocket. */
export class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventWaiters = new Set<EventWaiter>()
  private readonly listeners = new Set<(method: string, params: unknown) => void>()
  private closed = false

  constructor(private readonly socket: CdpSocket) {}

  /** Whether the transport has been closed. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Send one command and await its response or error. */
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CDP socket is closed'))
    const id = this.nextId
    this.nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command ${method} timed out`))
      }, 30_000)
      this.pending.set(id, { command: method, resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Subscribe to every incoming event. */
  onEvent(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolve when an event with the given method arrives (or timeout). */
  waitForEvent(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error(`CDP event ${method} timed out`))
      }, timeoutMs)
      const waiter: EventWaiter = {
        method,
        resolve: (params) => {
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve(params)
        },
        reject,
        timer,
      }
      waiters.add(waiter)
    })
  }

  /** Feed one raw websocket frame into the client. */
  handleFrame(raw: string): void {
    if (this.closed) return
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(message)) return
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error !== undefined && isRecord(message.error)) {
        const rawMessage = message.error.message
        const rawCode = message.error.code
        const messageText = typeof rawMessage === 'string' ? rawMessage : 'CDP error'
        const code = typeof rawCode === 'number' ? rawCode : -1
        pending.reject(new CdpError(`${messageText} (${pending.command})`, code))
        return
      }
      pending.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string') return
    for (const listener of this.listeners) listener(message.method, message.params)
    for (const waiter of waiters) {
      if (waiter.method === message.method) waiter.resolve(message.params)
    }
  }

  /** Close the transport and reject anything still waiting. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const reason = new Error('CDP socket closed')
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
    this.socket.close()
  }
}

const waiters = new Set<EventWaiter>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
