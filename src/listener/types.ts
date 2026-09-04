/**
 * Trace vocabulary shared by the in-app probe runtime and the local listener.
 * Events are lossless-JSON by construction so they can be persisted as JSONL.
 *
 * @module dsh-debug-mode/listener/types
 */

/** JSON-safe value accepted by the trace pipeline. */
export type TraceJson =
  null | boolean | number | string | TraceJson[] | { [key: string]: TraceJson }

/** What a trace record describes. */
export type TraceKind = 'probe' | 'heartbeat' | 'exception'

/** One normalized trace record. */
export interface TraceEvent {
  readonly kind: TraceKind
  readonly runId: string
  /** Per-run monotonically increasing sequence assigned by the store. */
  readonly seq: number
  readonly ts: number
  readonly file?: string
  readonly line?: number
  readonly functionName?: string
  readonly text?: string
  /** Safe variable snapshot. */
  readonly locals?: TraceJson
  /** Keys whose values were withheld. */
  readonly redacted?: readonly string[]
}
