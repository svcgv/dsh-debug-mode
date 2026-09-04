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

/** Factory that mints one independent runtime instance per run. */
export type DebugRuntimeFactory = (runId: string) => DebugRuntime

const factories = new Map<DebugRunKind, DebugRuntimeFactory>()

/** Register the runtime factory for one family (replaces any previous entry). */
export function registerDebugRuntime(kind: DebugRunKind, factory: DebugRuntimeFactory): void {
  factories.set(kind, factory)
}

/** Resolve the registered factory for one family, if any. */
export function resolveDebugRuntime(kind: DebugRunKind): DebugRuntimeFactory | undefined {
  return factories.get(kind)
}
