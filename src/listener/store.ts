/**
 * Bounded trace store for one debug run. Events are assigned monotonic
 * sequences, queued through one mutation owner, and optionally persisted as
 * JSONL before becoming visible to readers. The store never exceeds its
 * memory, file, or pending-operation caps.
 *
 * @module dsh-debug-mode/listener/store
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TraceEvent } from './types.ts'

/** Store bounds. */
export interface TraceStoreLimits {
  readonly maxEvents: number
  readonly maxBytes: number
}

/** Default store bounds. */
export const DEFAULT_STORE_LIMITS: TraceStoreLimits = {
  maxEvents: 10_000,
  maxBytes: 64 * 1024 * 1024,
}

/** A cursor is the exclusive upper bound seq already delivered. */
export type TraceCursor = number

/** One bounded read page. */
export interface TracePage {
  readonly events: readonly TraceEvent[]
  readonly nextCursor: TraceCursor
  readonly hasMore: boolean
}

/** Stable failure codes raised by a persistent trace store. */
export type TraceStoreErrorCode =
  | 'TRACE_STORE_NOT_READY'
  | 'TRACE_STORE_CLOSED'
  | 'TRACE_STORE_BUSY'
  | 'TRACE_LOG_EXISTS'
  | 'TRACE_PERSISTENCE_FAILED'

/** A trace-store failure with a stable recovery-relevant code. */
export class TraceStoreError extends Error {
  override readonly name = 'TraceStoreError'

  constructor(
    readonly code: TraceStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

interface Waiter {
  readonly targetSeq: number
  readonly resolve: (value: boolean) => void
  readonly timer: NodeJS.Timeout
}

const MAX_PENDING_OPERATIONS = 1_000

/** Append-only bounded store owned by one debug run. */
export class TraceStore {
  private readonly events: TraceEvent[] = []
  private readonly waiters = new Set<Waiter>()
  private bytes = 0
  private persistedBytes = 0
  private nextSeq = 0
  private dropped = 0
  private pendingOperations = 0
  private mutationQueue: Promise<void> = Promise.resolve()
  private initialized: boolean
  private closed = false
  private persistenceFailure: TraceStoreError | undefined

  constructor(
    private readonly limits: TraceStoreLimits = DEFAULT_STORE_LIMITS,
    readonly logPath = '',
  ) {
    this.initialized = logPath === ''
  }

  /** Number of events retained in memory (drops excluded). */
  get count(): number {
    return this.events.length
  }

  /** Number of events dropped by memory or file caps. */
  get droppedCount(): number {
    return this.dropped
  }

  /** Number of events waiting for serialized mutation and persistence. */
  get pendingCount(): number {
    return this.pendingOperations
  }

  /** Create a new run-owned JSONL file before the listener accepts events. */
  async initialize(): Promise<void> {
    if (this.closed) throw this.closedError()
    if (this.initialized) return
    const logPath = this.logPath
    try {
      await mkdir(dirname(logPath), { recursive: true })
      await writeFile(logPath, '', { encoding: 'utf8', flag: 'wx' })
      this.initialized = true
    } catch (cause) {
      if (isNodeError(cause) && cause.code === 'EEXIST') {
        throw new TraceStoreError(
          'TRACE_LOG_EXISTS',
          'The run-owned trace log already exists; refusing to overwrite it. Use a new debug run id or recover the existing run explicitly.',
          { cause },
        )
      }
      throw new TraceStoreError(
        'TRACE_PERSISTENCE_FAILED',
        'The run-owned trace log could not be created; check the project directory permissions and disk availability before retrying.',
        { cause },
      )
    }
  }

  /** Append one event, persist it first when configured, and return its sequence. */
  append(event: Omit<TraceEvent, 'seq'>): Promise<number | null> {
    if (this.closed) return Promise.reject(this.closedError())
    if (!this.initialized) {
      return Promise.reject(
        new TraceStoreError(
          'TRACE_STORE_NOT_READY',
          'The trace store has not been initialized; initialize the run-owned log before accepting events.',
        ),
      )
    }
    if (this.persistenceFailure !== undefined) return Promise.reject(this.persistenceFailure)
    if (this.pendingOperations >= MAX_PENDING_OPERATIONS) {
      return Promise.reject(
        new TraceStoreError(
          'TRACE_STORE_BUSY',
          'The trace store write queue is full; reduce probe volume or retry after the current batch drains.',
        ),
      )
    }

    this.pendingOperations += 1
    const operation = this.mutationQueue.then(() => this.appendOne(event))
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation.finally(() => {
      this.pendingOperations -= 1
    })
  }

  /** Read one bounded page after `cursor` (defaults to the last delivered position). */
  read(cursor: TraceCursor = -1, limit = 200): TracePage {
    const start = this.events.findIndex((event) => event.seq > cursor)
    const pageLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const slice = start === -1 ? [] : this.events.slice(start, start + pageLimit)
    const last = slice[slice.length - 1]
    const nextCursor = last === undefined ? cursor : last.seq
    const consumed = start === -1 ? 0 : start + slice.length
    return { events: slice, nextCursor, hasMore: this.events.length > consumed }
  }

  /** Wait until at least `targetSeq` (exclusive upper bound) exists or timeout elapses. */
  waitFor(targetSeq: TraceCursor, timeoutMs: number): Promise<boolean> {
    if (targetSeq <= this.latestSeq) return Promise.resolve(true)
    if (this.closed || timeoutMs <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        targetSeq,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          resolve(false)
        }, timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  /** Flush queued writes and close the store-owned lifecycle. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.resolveWaiters(false)
    await this.mutationQueue
  }

  private async appendOne(event: Omit<TraceEvent, 'seq'>): Promise<number | null> {
    if (this.persistenceFailure !== undefined) throw this.persistenceFailure
    const serialized = JSON.stringify(event)
    const eventBytes = Buffer.byteLength(serialized, 'utf8')
    if (eventBytes > this.limits.maxBytes || this.bytes + eventBytes > this.limits.maxBytes) {
      this.dropped += 1
      return null
    }

    const seq = this.nextSeq
    const eventWithSeq = { ...event, seq } satisfies TraceEvent
    const line = `${JSON.stringify(eventWithSeq)}\n`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (this.logPath !== '' && this.persistedBytes + lineBytes > this.limits.maxBytes) {
      this.dropped += 1
      return null
    }

    if (this.logPath !== '') {
      try {
        await appendFile(this.logPath, line, 'utf8')
        this.persistedBytes += lineBytes
      } catch (cause) {
        const failure = new TraceStoreError(
          'TRACE_PERSISTENCE_FAILED',
          'The trace event was collected but could not be saved to the run-owned local log; check disk availability and permissions, then finish or recover the run.',
          { cause },
        )
        this.persistenceFailure = failure
        throw failure
      }
    }

    this.nextSeq += 1
    if (this.events.length >= this.limits.maxEvents) {
      const removed = this.events[0]
      this.events.shift()
      this.bytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8')
      this.dropped += 1
    }
    this.events.push(eventWithSeq)
    this.bytes += eventBytes
    this.settleWaiters()
    return seq
  }

  private get latestSeq(): number {
    return this.nextSeq - 1
  }

  private settleWaiters(): void {
    const latest = this.latestSeq
    for (const waiter of this.waiters) {
      if (latest >= waiter.targetSeq) {
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        waiter.resolve(true)
      }
    }
  }

  private resolveWaiters(value: boolean): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(value)
    }
    this.waiters.clear()
  }

  private closedError(): TraceStoreError {
    return new TraceStoreError('TRACE_STORE_CLOSED', 'The trace store has already been closed.')
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
