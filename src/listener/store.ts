/**
 * Bounded in-memory trace store for one debug run. Events are assigned a
 * monotonic sequence at append and read through opaque cursors; the store
 * never grows past its caps and waits for new events without busy-polling.
 *
 * @module dsh-debug-mode/listener/store
 */

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

interface Waiter {
  readonly targetSeq: number
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
  readonly timer: NodeJS.Timeout
}

const waiters = new Set<Waiter>()

/** Append-only bounded store owned by one debug run. */
export class TraceStore {
  private readonly events: TraceEvent[] = []
  private bytes = 0
  private nextSeq = 0
  private dropped = 0
  constructor(private readonly limits: TraceStoreLimits = DEFAULT_STORE_LIMITS) {}

  /** Number of events retained (drops excluded). */
  get count(): number {
    return this.events.length
  }

  /** Number of events dropped by the caps. */
  get droppedCount(): number {
    return this.dropped
  }

  /** Append one raw event and return its assigned sequence (or null on drop). */
  append(event: Omit<TraceEvent, 'seq'>): number | null {
    const serialized = JSON.stringify(event)
    if (serialized.length > this.limits.maxBytes) {
      this.dropped += 1
      return null
    }
    if (this.bytes + serialized.length > this.limits.maxBytes) {
      this.dropped += 1
      return null
    }
    if (this.events.length >= this.limits.maxEvents) {
      const excess = this.events.length - (this.limits.maxEvents - 1)
      const removed = this.events.splice(0, excess)
      for (const removedEvent of removed) {
        this.bytes -= JSON.stringify(removedEvent).length
        this.dropped += 1
      }
    }
    const seq = this.nextSeq
    this.nextSeq += 1
    const eventWithSeq = { ...event, seq } satisfies TraceEvent
    this.events.push(eventWithSeq)
    this.bytes += serialized.length
    this.settleWaiters()
    return seq
  }

  /** Read one bounded page after `cursor` (defaults to the last delivered position). */
  read(cursor: TraceCursor = -1, limit = 200): TracePage {
    const start = this.events.findIndex((event) => event.seq > cursor)
    const slice = start === -1 ? [] : this.events.slice(start, start + Math.max(1, limit))
    const last = slice[slice.length - 1]
    const nextCursor = last === undefined ? cursor : last.seq
    const consumed = start === -1 ? 0 : start + slice.length
    return { events: slice, nextCursor, hasMore: this.events.length > consumed }
  }

  /** Wait until at least `targetSeq` (exclusive upper bound) exists or the timeout elapses. */
  waitFor(targetSeq: TraceCursor, timeoutMs: number): Promise<boolean> {
    if (targetSeq <= this.latestSeq) return Promise.resolve(true)
    if (timeoutMs <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        resolve(false)
      }, timeoutMs)
      const waiter: Waiter = {
        targetSeq,
        resolve: () => {
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve(true)
        },
        reject,
        timer,
      }
      waiters.add(waiter)
    })
  }

  private get latestSeq(): number {
    return this.nextSeq - 1
  }

  private settleWaiters(): void {
    const latest = this.latestSeq
    for (const waiter of waiters) {
      if (latest >= waiter.targetSeq) waiter.resolve()
    }
  }
}
