/**
 * DebugRunManager: the single owner of one debug run per session. The core is
 * transport-agnostic: runtime adapters implement the `DebugRuntime` seam and
 * the manager enforces lifecycle, exclusivity, and bounded result shape.
 *
 * @module dsh-debug-mode/run/manager
 */

import type {
  DebugControlRequest,
  DebugControlResult,
  DebugFinishOutcome,
  DebugFinishResult,
  DebugRunError,
  DebugRunErrorCode,
  DebugRunKind,
  DebugRunStatus,
  DebugStartRequest,
  DebugStartResult,
} from './types.ts'

/** Successful start returned by one runtime adapter (id minted by the manager). */
export type RuntimeStartOk = {
  readonly kind: 'ok'
  readonly kindOfRun: DebugRunKind
  readonly status: Extract<
    DebugRunStatus,
    'preparing' | 'waiting-for-reproduction' | 'paused' | 'diagnosing'
  >
  readonly notice: string
}

/** Successful control returned by one runtime adapter. */
export type RuntimeControlOk = {
  readonly kind: 'ok'
  readonly status: DebugRunStatus
  readonly cursor?: string
  readonly text: string
}

/** Successful finish returned by one runtime adapter. */
export type RuntimeFinishOk = {
  readonly kind: 'ok'
  readonly status: 'finished'
  readonly restored: readonly string[]
  readonly couldNotRestore: readonly string[]
  readonly summary: string
}

/** One control action the runtime seam must support. */
export interface DebugRuntime {
  readonly kind: DebugRunKind
  start(request: DebugStartRequest): Promise<RuntimeStartOk | DebugRunError>
  control(action: string, request: DebugControlRequest): Promise<RuntimeControlOk | DebugRunError>
  finish(outcome: DebugFinishOutcome): Promise<RuntimeFinishOk | DebugRunError>
}

/** Resolve the runtime adapter for a classified kind, if one is composed. */
export type DebugRuntimeResolver = (kind: DebugRunKind) => DebugRuntime | undefined

interface RunRecord {
  readonly runId: string
  readonly kind: DebugRunKind
  readonly runtime: DebugRuntime
  status: DebugRunStatus
}

function error(code: DebugRunErrorCode, message: string, retryable: boolean): DebugRunError {
  return { kind: 'error', code, message, retryable }
}

const ID_PREFIX = 'dsh-debug-run-'

/** One active run per session, keyed by session id. */
export class DebugRunManager {
  private readonly records = new Map<string, RunRecord>()
  private readonly resolveRuntime: DebugRuntimeResolver
  private nextSequence = 0

  constructor(resolveRuntime: DebugRuntimeResolver) {
    this.resolveRuntime = resolveRuntime
  }

  /** Mint the next run id for one session. */
  private mintRunId(sessionId: string): string {
    this.nextSequence += 1
    return `${ID_PREFIX}${sessionId}-${this.nextSequence}`
  }

  /** Whether a session currently owns a run. Records never survive a final phase. */
  hasActiveRun(sessionId: string): boolean {
    return this.records.has(sessionId)
  }

  /** Read the live status of one session's run. */
  status(sessionId: string): { runId?: string; status?: DebugRunStatus } {
    const record = this.records.get(sessionId)
    return record === undefined ? {} : { runId: record.runId, status: record.status }
  }

  /** Classify a requested runtime into a concrete kind; auto defaults to frontend. */
  classify(request: DebugStartRequest): DebugRunKind | undefined {
    if (request.runtime !== 'auto') return request.runtime
    return request.targets.length === 0 ? undefined : 'frontend'
  }

  /** Start one run for a session, rejecting concurrent runs and missing adapters loudly. */
  async start(
    sessionId: string,
    request: DebugStartRequest,
  ): Promise<DebugStartResult | DebugRunError> {
    if (this.hasActiveRun(sessionId)) {
      return error(
        'RUN_ALREADY_ACTIVE',
        'This session already has an active debug run; finish it before starting another.',
        false,
      )
    }
    const validation = validateStartRequest(request)
    if (validation !== null) return validation
    // Validation guarantees at least one target, so auto classification always
    // resolves to the frontend family here.
    const kind: DebugRunKind = request.runtime === 'auto' ? 'frontend' : request.runtime
    const runtime = this.resolveRuntime(kind)
    if (runtime === undefined) {
      return error(
        'RUNTIME_UNAVAILABLE',
        `The ${kind} runtime adapter is not available in this build; install the matching dsh-debug-mode adapter bundle.`,
        false,
      )
    }
    const runId = this.mintRunId(sessionId)
    const record: RunRecord = { runId, kind, runtime, status: 'preparing' }
    this.records.set(sessionId, record)
    const outcome = await runtime.start(request)
    if (outcome.kind === 'error') {
      this.records.delete(sessionId)
      return outcome
    }
    record.status = outcome.status
    return {
      kind: 'ok',
      runId,
      kindOfRun: outcome.kindOfRun,
      status: outcome.status,
      notice: outcome.notice,
    }
  }

  /** Dispatch one control verb to the active run. */
  async control(
    sessionId: string,
    request: DebugControlRequest,
  ): Promise<DebugControlResult | DebugRunError> {
    const record = this.records.get(sessionId)
    if (record === undefined) {
      return error(
        'NO_ACTIVE_RUN',
        'No active debug run exists for this session; call debug_start first.',
        false,
      )
    }
    if (record.status === 'failed') {
      return error('NOT_READY', `Cannot control a run in status ${record.status}.`, false)
    }
    const outcome = await record.runtime.control(request.action, request)
    if (outcome.kind === 'ok') record.status = outcome.status
    return outcome.kind === 'ok'
      ? {
          kind: 'ok',
          runId: record.runId,
          status: outcome.status,
          ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }),
          text: outcome.text,
        }
      : outcome
  }

  /** Finish the active run and release the session slot. */
  async finish(
    sessionId: string,
    outcome: DebugFinishOutcome,
  ): Promise<DebugFinishResult | DebugRunError> {
    const record = this.records.get(sessionId)
    if (record === undefined) {
      return error(
        'NO_ACTIVE_RUN',
        'No active debug run exists for this session; there is nothing to finish.',
        false,
      )
    }
    record.status = 'finishing'
    const result = await record.runtime.finish(outcome)
    this.records.delete(sessionId)
    if (result.kind === 'error') return result
    return {
      kind: 'ok',
      runId: record.runId,
      status: 'finished',
      restored: result.restored,
      couldNotRestore: result.couldNotRestore,
      summary: result.summary,
    }
  }

  /** Remove a crashed session's slot without invoking runtime cleanup. */
  abandon(sessionId: string): boolean {
    return this.records.delete(sessionId)
  }
}

/** Validate target lines and runtime grammar, returning a structured error or null. */
export function validateStartRequest(request: {
  targets: readonly { path: string; startLine: number; endLine: number }[]
  runtime: string
}): DebugRunError | null {
  if (request.targets.length === 0 || request.targets.length > 5) {
    return error('INVALID_TARGETS', 'debug_start requires between 1 and 5 target ranges.', false)
  }
  for (const target of request.targets) {
    if (target.path.trim() === '') {
      return error('INVALID_TARGETS', 'Every debug target needs a non-empty file path.', false)
    }
    if (
      !Number.isSafeInteger(target.startLine) ||
      !Number.isSafeInteger(target.endLine) ||
      target.startLine < 1 ||
      target.endLine < target.startLine
    ) {
      return error(
        'INVALID_TARGETS',
        `debug target ${target.path} has an invalid line range (startLine and endLine must be positive integers with endLine >= startLine).`,
        false,
      )
    }
  }
  if (
    request.runtime !== 'auto' &&
    request.runtime !== 'frontend' &&
    request.runtime !== 'backend'
  ) {
    return error('INVALID_TARGETS', 'runtime must be "auto", "frontend", or "backend".', false)
  }
  return null
}
