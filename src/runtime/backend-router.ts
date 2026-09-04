/**
 * Routes backend debug starts to the Node or Python adapter based on the
 * target file extension. One session still owns exactly one inner runtime.
 *
 * @module dsh-debug-mode/runtime/backend-router
 */

import type {
  DebugRuntime,
  RuntimeControlOk,
  RuntimeFinishOk,
  RuntimeStartOk,
} from '../run/manager.ts'
import type {
  DebugControlRequest,
  DebugFinishOutcome,
  DebugRunError,
  DebugStartRequest,
} from '../run/types.ts'
import { NodeBackendRuntime } from './node-backend.ts'
import { PythonBackendRuntime } from './python-backend.ts'

/** Backend router owned by one run id. */
export class BackendRouterRuntime implements DebugRuntime {
  readonly kind = 'backend' as const
  private inner: DebugRuntime | undefined

  constructor(private readonly runId: string) {}

  async start(request: DebugStartRequest): Promise<RuntimeStartOk | DebugRunError> {
    const first = request.targets[0]
    const target = first?.path ?? ''
    this.inner = target.endsWith('.py')
      ? new PythonBackendRuntime(this.runId)
      : new NodeBackendRuntime(this.runId)
    return this.inner.start(request)
  }

  async control(
    action: string,
    request: DebugControlRequest,
  ): Promise<RuntimeControlOk | DebugRunError> {
    const inner = this.inner
    if (inner === undefined)
      return {
        kind: 'error',
        code: 'NO_ACTIVE_RUN',
        message: 'No backend run started.',
        retryable: false,
      }
    return inner.control(action, request)
  }

  async finish(outcome: DebugFinishOutcome): Promise<RuntimeFinishOk | DebugRunError> {
    const inner = this.inner
    this.inner = undefined
    if (inner === undefined)
      return {
        kind: 'ok',
        status: 'finished',
        restored: [],
        couldNotRestore: [],
        summary: 'No backend run was active.',
      }
    return inner.finish(outcome)
  }
}
