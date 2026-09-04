/**
 * Host entry of the dsh-debug-mode bundle. This module is what the
 * `debug-mode` loader row mounts; it re-exports the structural controller and
 * declares the root services the controller needs before apply runs.
 *
 * @module dsh-debug-mode/host
 */

export { apply, buildDebugProjectionDefinition, handleDebugCommand, name } from './mode/host.ts'
export type { DebugModeConfig } from './mode/host.ts'
export {
  DEBUG_PROJECTION_KEY,
  DEBUG_PROJECTION_STATE_VERSION,
  applyDebugEvent,
  initDebugUnitState,
  isOffCommand,
  parseDebugIntent,
  parseDebugUnitState,
  toErrorMessage,
  viewDebugProjection,
} from './mode/fold.ts'
export { DEBUG_POLICY_ORDER } from './mode/policy.ts'
export type { DebugFoldEvent, DebugProjection, DebugUnitState } from './mode/types.ts'

/** Root services the debug-mode controller registers into. */
export const inject = ['sessionProjections', 'systemPrompt', 'tools']
