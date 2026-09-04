/**
 * Pure debug-mode domain types shared by the host fold, the policy gate, and
 * the client projection. This module imports nothing from the harness: events
 * are structural records so the fold is unit-testable outside Cordis.
 *
 * @module dsh-debug-mode/mode
 */

/** Client-visible projection of the debug-mode collaboration state. */
export interface DebugProjection {
  /** Debug mode is committed and in force. */
  active: boolean
  /** A logged `/debug` selection targets a state other than the committed one. */
  pending: boolean
}

/** Host fold state for one session log. */
export interface DebugUnitState {
  /** The committed debug-mode state after the last successful `/debug` command. */
  active: boolean
  /** The most recent `/debug` command awaiting its paired `command/done`, if any. */
  running: { commandId: string; wanted: boolean } | null
}

/** Structural view of a session event this fold understands. */
export interface DebugFoldEvent {
  readonly type: string
  readonly data: {
    readonly commandId?: unknown
    readonly name?: unknown
    readonly args?: unknown
    readonly kind?: unknown
  }
}

/** Structural view of the session whose mode the fold tracks. */
export interface DebugFoldSessionLike {
  readonly id: string
}

/** Parse result for a raw `/debug` line, mirroring the registry's rawInput shape. */
export type DebugCommandIntent =
  { readonly kind: 'enter'; readonly message: string } | { readonly kind: 'exit' }

/** A session the host controller can switch modes on. */
export interface DebugModeAgentLike {
  readonly session: DebugFoldSessionLike
  /** Optional plan-mode service composed by the deployment (plan-mode row). */
  readonly ctx?: {
    get(
      name: 'planMode',
    ):
      | { set(agent: unknown, active: boolean): unknown; get(agent: unknown): { active: boolean } }
      | undefined
  }
}
