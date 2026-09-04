/**
 * Runtime adapter registry shared by the host controller and the frontend /
 * backend adapter modules. Adapter modules call `registerDebugRuntime` at
 * load; the controller resolves adapters through this seam so the bundle can
 * ship one or both families without changing the manager.
 *
 * @module dsh-debug-mode/run/registry
 */

import type { DebugRunKind } from './types.ts'
import type { DebugRuntime } from './manager.ts'

const adapters = new Map<DebugRunKind, DebugRuntime>()

/** Register the runtime adapter for one family (replaces any previous entry). */
export function registerDebugRuntime(kind: DebugRunKind, runtime: DebugRuntime): void {
  adapters.set(kind, runtime)
}

/** Resolve the registered adapter for one family, if any. */
export function resolveDebugRuntime(kind: DebugRunKind): DebugRuntime | undefined {
  return adapters.get(kind)
}
