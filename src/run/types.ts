/**
 * Pure debug-run vocabulary shared by the run manager, the model tools, and
 * the future frontend/backend runtime adapters. No harness import.
 *
 * @module dsh-debug-mode/run
 */

/** One located source range the agent wants instrumented or paused. */
export interface DebugTarget {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
}

/** Which runtime family a debug session targets. */
export type DebugRuntimeMode = 'auto' | 'frontend' | 'backend'

/** Resolved runtime kind after classification. */
export type DebugRunKind = 'frontend' | 'backend'

/** Lifecycle phases of one debug run. */
export type DebugRunStatus =
  | 'preparing'
  | 'waiting-for-reproduction'
  | 'paused'
  | 'diagnosing'
  | 'finishing'
  | 'finished'
  | 'failed'

/** How a run ends. */
export type DebugFinishOutcome = 'diagnosed' | 'verified' | 'cancelled'

/** Unified control verbs the model can invoke on one run. */
export type DebugControlAction =
  | 'status'
  | 'wait'
  | 'read'
  | 'switch_endpoint'
  | 'reinstrument'
  | 'continue'
  | 'next'
  | 'step_in'
  | 'step_out'
  | 'stack'
  | 'scopes'
  | 'evaluate'

/** Request payload of debug_start. */
export interface DebugStartRequest {
  readonly targets: readonly DebugTarget[]
  readonly runtime: DebugRuntimeMode
  readonly launchId?: string
  /**
   * Backend only: when an ordinary service already runs the target script,
   * true stops it (after the user confirmed the process and restart command
   * shown by the first attempt) and restarts it on finish. Defaults to false:
   * the first attempt returns CONFIRMATION_REQUIRED with the process detail.
   */
  readonly stopExisting?: boolean
}

/** Control request payload of debug_control. */
export interface DebugControlRequest {
  readonly action: DebugControlAction
  readonly cursor?: string
  readonly timeoutMs?: number
  readonly frameId?: string
  readonly expression?: string
}

/** Stable failure taxonomy for run lifecycle operations. */
export type DebugRunErrorCode =
  | 'RUN_ALREADY_ACTIVE'
  | 'NO_ACTIVE_RUN'
  | 'RUNTIME_UNAVAILABLE'
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_TARGETS'
  | 'UNSUPPORTED_ACTION'
  | 'UNSUPPORTED_TARGET'
  | 'NOT_READY'
  | 'FINISH_IN_PROGRESS'

/** One structured failure returned by the run seam. */
export interface DebugRunError {
  readonly kind: 'error'
  readonly code: DebugRunErrorCode
  readonly message: string
  readonly retryable: boolean
}

/** Successful start of a debug run. */
export interface DebugStartResult {
  readonly kind: 'ok'
  readonly runId: string
  readonly kindOfRun: DebugRunKind
  readonly status: DebugRunStatus
  /** Instructions the model should relay to the user. */
  readonly notice: string
}

/** Successful control outcome carrying bounded evidence. */
export interface DebugControlResult {
  readonly kind: 'ok'
  readonly runId: string
  readonly status: DebugRunStatus
  readonly cursor?: string
  readonly text: string
}

/** Successful finish summary. */
export interface DebugFinishResult {
  readonly kind: 'ok'
  readonly runId: string
  readonly status: 'finished'
  readonly restored: readonly string[]
  readonly couldNotRestore: readonly string[]
  readonly summary: string
}

/** Union of every run seam result. */
export type DebugRunResult =
  DebugStartResult | DebugControlResult | DebugFinishResult | DebugRunError
