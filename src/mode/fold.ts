/**
 * Pure event fold for the debug-mode projection. `/debug` and `/debug off`
 * command records are the primary durable inputs, and the in-repo `plan/mode`
 * activation event is folded so Normal / Plan / Debug stay mutually exclusive
 * in both directions: entering plan mode durably exits debug mode, mirroring
 * the `/debug` handler calling `planMode.set(false)`. The fold deliberately
 * writes no custom session event because an out-of-repo plugin event would be
 * refused by the harness persistence seam unless its envelope carried an
 * ignorable marker that the in-process append API cannot set. The folded
 * inputs are known in-repo event types, so the derived state survives
 * restart, resume, and fork without a custom vocabulary.
 *
 * @module dsh-debug-mode/mode/fold
 */

import type {
  DebugCommandIntent,
  DebugFoldEvent,
  DebugProjection,
  DebugUnitState,
} from './types.ts'

/** Projection key owned by this domain. */
export const DEBUG_PROJECTION_KEY = 'debug' as const

/** Bump when the serialized state fields or fold semantics change. */
export const DEBUG_PROJECTION_STATE_VERSION = 1

/** State for the empty log. */
export function initDebugUnitState(): DebugUnitState {
  return { active: false, running: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDebugRun(event: DebugFoldEvent): boolean {
  return (
    event.type === 'command/run' &&
    event.data.name === 'debug' &&
    typeof event.data.args === 'string'
  )
}

function isDebugDone(event: DebugFoldEvent): boolean {
  return (
    event.type === 'command/done' &&
    typeof event.data.commandId === 'string' &&
    typeof event.data.kind === 'string'
  )
}

/** Whether the native plan service durably committed plan mode on. */
function isPlanActivation(event: DebugFoldEvent): boolean {
  return event.type === 'plan/mode' && isRecord(event.data) && event.data.active === true
}

/** Whether the raw command line selects `off`. */
export function isOffCommand(raw: string): boolean {
  return raw.trim() === 'off'
}

/** Pure transition: previous state + one committed event. */
export function applyDebugEvent(state: DebugUnitState, event: DebugFoldEvent): DebugUnitState {
  // Plan activation wins over any in-flight debug selection: once plan mode is
  // durably on, debug is off and stays off until a later `/debug` command.
  if (isPlanActivation(event)) return { active: false, running: null }
  if (isDebugRun(event)) {
    const commandId = typeof event.data.commandId === 'string' ? event.data.commandId : ''
    const wanted = !isOffCommand(String(event.data.args))
    return commandId === '' ? state : { active: state.active, running: { commandId, wanted } }
  }
  if (
    isDebugDone(event) &&
    state.running !== null &&
    event.data.commandId === state.running.commandId
  ) {
    return event.data.kind === 'success'
      ? { active: state.running.wanted, running: null }
      : { active: state.active, running: null }
  }
  return state
}

/** Client view: pending while a logged selection differs from the committed state. */
export function viewDebugProjection(state: DebugUnitState): DebugProjection {
  const pending = state.running !== null && state.running.wanted !== state.active
  return { active: state.active, pending }
}

/** Parse and validate a persisted unit state, throwing on malformed rows. */
export function parseDebugUnitState(value: unknown): DebugUnitState {
  if (!isRecord(value) || typeof value.active !== 'boolean') {
    throw new Error('debug projection state must be an object with a boolean "active"')
  }
  const runningValue = value.running
  if (runningValue === null) return { active: value.active, running: null }
  if (
    isRecord(runningValue) &&
    typeof runningValue.commandId === 'string' &&
    typeof runningValue.wanted === 'boolean'
  ) {
    return {
      active: value.active,
      running: { commandId: runningValue.commandId, wanted: runningValue.wanted },
    }
  }
  throw new Error('debug projection state carries an invalid "running" record')
}

/** Parse and validate a wire projection view, rejecting malformed rows. */
export function parseDebugProjectionView(value: unknown): DebugProjection {
  if (!isRecord(value) || typeof value.active !== 'boolean' || typeof value.pending !== 'boolean') {
    throw new Error('debug projection view must be an object with boolean "active" and "pending"')
  }
  return { active: value.active, pending: value.pending }
}

/** Codec-shaped state parser accepted by the harness projection registry. */
export const debugStateCodec = {
  parse(value: unknown): DebugUnitState {
    return parseDebugUnitState(value)
  },
} as const

/** Convert an unknown thrown value to a stable user-visible failure line. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parse a raw `/debug` line into a command intent, mirroring the plan command grammar. */
export function parseDebugIntent(raw: string, hasAttachments: boolean): DebugCommandIntent {
  const message = raw.trim()
  if (message === 'off') {
    if (hasAttachments) throw new Error('Attachments cannot accompany /debug off.')
    return { kind: 'exit' }
  }
  return { kind: 'enter', message }
}
