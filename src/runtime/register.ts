/**
 * Registers the frontend runtime factory with the shared adapter registry.
 * Imported by the host entry so `debug_start` can resolve a fresh
 * `FrontendRuntime` per run.
 *
 * @module dsh-debug-mode/runtime/register
 */

import { registerDebugRuntime } from '../run/registry.ts'
import { FrontendRuntime } from './frontend.ts'
import { BackendRouterRuntime } from './backend-router.ts'

/** Register the frontend factory once. Subsequent calls replace the entry. */
export function registerFrontendRuntime(): void {
  registerDebugRuntime('frontend', (runId) => new FrontendRuntime(runId))
}

/** Register the backend router factory once (Node and Python targets). */
export function registerBackendRuntime(): void {
  registerDebugRuntime('backend', (runId) => new BackendRouterRuntime(runId))
}
