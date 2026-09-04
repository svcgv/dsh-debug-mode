/**
 * Host entry of the dsh-debug-mode bundle. The module is deliberately
 * structural: it never imports a harness package at runtime, so the same code
 * unit-tests outside Cordis and boots inside a harness profile through the
 * bundle patch.
 *
 * @module dsh-debug-mode
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
