/**
 * Node.js backend debug runtime for long-running services. The target runs
 * under `--inspect`, the debugger attaches, waits for the target script to be
 * parsed, sets breakpoints by script id, and then waits for user reproduction
 * traffic to hit them. Only the child this runtime started is ever killed.
 *
 * @module dsh-debug-mode/runtime/node-backend
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { CdpClient } from './cdp.ts'
import { findServicePids, listProcesses } from './process.ts'
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

function error(code: DebugRunError['code'], message: string): DebugRunError {
  return { kind: 'error', code, message, retryable: false }
}

interface PauseFrame {
  readonly functionName: string
  readonly lineNumber: number
  readonly callFrameId?: string
}

interface PauseState {
  readonly frames: readonly PauseFrame[]
  readonly reason: string
}

interface WaitEntry {
  readonly resolve: (state: PauseState) => void
  readonly reject: (reason: unknown) => void
  readonly timer: NodeJS.Timeout
}

/** Extract the inspector websocket URL from stderr. */
export function parseDebuggerWsUrl(output: string): string | undefined {
  const match = /Debugger listening on (ws:\/\/[^\s]+)/.exec(output)
  return match?.[1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms))
}

/** One running Node debug session for a long-lived service. */
export class NodeBackendRuntime implements DebugRuntime {
  readonly kind = 'backend' as const
  private child: ChildProcess | undefined
  private client: CdpClient | undefined
  private readonly waits = new Set<WaitEntry>()
  private readonly scripts = new Map<string, string>()
  private pause: PauseState | undefined
  private status: 'waiting-for-reproduction' | 'paused' | 'diagnosing' = 'waiting-for-reproduction'

  constructor(private readonly runId: string) {}

  async start(request: DebugStartRequest): Promise<RuntimeStartOk | DebugRunError> {
    const first = request.targets[0]
    if (first === undefined)
      return error('INVALID_TARGETS', 'debug_start requires at least one target file.')
    const script = resolve(first.path)
    if (!/\.(js|cjs|mjs)$/i.test(script)) {
      return error(
        'UNSUPPORTED_TARGET',
        'The Node backend currently supports .js, .cjs, and .mjs services; TS entrypoints need a compiled run target.',
      )
    }
    if (process.platform !== 'win32') {
      try {
        const rows = await listProcesses()
        const existing = findServicePids(rows, script, process.pid)
        if (existing.length > 0) {
          return error(
            'RUNTIME_UNAVAILABLE',
            `A normal service for ${script} is already running (pid ${existing.join(', ')}). Stop it first or use a launch configuration that owns the process.`,
          )
        }
      } catch {
        // Process-table reads are best-effort; launch proceeds when unknown.
      }
    }
    return new Promise<RuntimeStartOk | DebugRunError>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', script], {
        cwd: dirname(script),
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      this.child = child
      let stderr = ''
      const failTimer = setTimeout(() => {
        cleanup()
        resolvePromise(
          error('INVALID_TARGETS', 'The Node process did not open an inspector within 15 seconds.'),
        )
      }, 15_000)
      const cleanup = (): void => {
        clearTimeout(failTimer)
        child.stderr?.removeAllListeners()
      }
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        const wsUrl = parseDebuggerWsUrl(stderr)
        if (wsUrl === undefined) return
        void this.configure(wsUrl, request).then(
          () => {
            cleanup()
            resolvePromise({
              kind: 'ok',
              kindOfRun: 'backend',
              status: 'waiting-for-reproduction',
              notice: `Started the Node service under the debugger with breakpoints set. Reproduce the issue now.`,
            })
          },
          (cause: unknown) => {
            cleanup()
            const message = cause instanceof Error ? cause.message : String(cause)
            resolvePromise(
              error('INVALID_TARGETS', `Could not attach the Node debugger: ${message}`),
            )
          },
        )
      })
      child.once('exit', (code) => {
        if (code === null) return
        cleanup()
        resolvePromise(
          error(
            'INVALID_TARGETS',
            `Node process exited before breakpoints were installed (code ${code}).`,
          ),
        )
      })
      child.once('error', (cause) => {
        cleanup()
        rejectPromise(cause)
      })
    })
  }

  async control(
    action: string,
    request: DebugControlRequest,
  ): Promise<RuntimeControlOk | DebugRunError> {
    switch (action) {
      case 'status':
        return this.statusResult()
      case 'wait': {
        const current = this.pause
        if (current !== undefined) return this.ok(this.renderPaused(current))
        return this.awaitPause(request)
      }
      case 'continue':
      case 'next':
      case 'step_in':
      case 'step_out':
        return this.step(action, request)
      case 'stack':
        return this.pause === undefined
          ? error('NOT_READY', 'No paused frame; reproduce the issue first.')
          : this.ok(this.renderPaused(this.pause))
      case 'evaluate': {
        const expression = request.expression
        if (expression === undefined || expression === '')
          return error('INVALID_TARGETS', 'evaluate requires an expression.')
        const client = this.client
        if (client === undefined) return error('NOT_READY', 'Node debugger is not attached.')
        const timeout = Math.max(0, request.timeoutMs ?? 8_000)
        const frameId = await this.waitForPausedFrame(client, timeout)
        if (frameId === undefined)
          return error(
            'NOT_READY',
            'No paused frame; reproduce the issue and retry evaluate while the debugger is stopped.',
          )
        const result = await client.send('Debugger.evaluateOnCallFrame', {
          callFrameId: frameId,
          expression,
        })
        return this.ok(this.renderEvaluate(result))
      }
      default:
        return error('UNSUPPORTED_ACTION', `Node backend does not support action "${action}".`)
    }
  }

  async finish(outcome: DebugFinishOutcome): Promise<RuntimeFinishOk | DebugRunError> {
    const child = this.child
    this.child = undefined
    this.client?.close()
    this.client = undefined
    this.settleAll(new Error('debug run finished'))
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((ok) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          ok()
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(timer)
          ok()
        })
        child.kill('SIGTERM')
      })
    }
    return {
      kind: 'ok',
      status: 'finished',
      restored: [],
      couldNotRestore: [],
      summary: `Finished ${outcome}: stopped the Node debug process and released the session.`,
    }
  }

  private async configure(wsUrl: string, request: DebugStartRequest): Promise<void> {
    const socket = new WebSocket(wsUrl)
    const client = new CdpClient({ send: (data) => socket.send(data), close: () => socket.close() })
    await new Promise<void>((ok, fail) => {
      socket.addEventListener('open', () => ok(), { once: true })
      socket.addEventListener('error', () => fail(new Error('websocket error')), { once: true })
    })
    socket.addEventListener('message', (event) => client.handleFrame(String(event.data)))
    this.client = client
    client.onEvent((method, params) => {
      if (method === 'Debugger.scriptParsed') this.recordScript(params)
      if (method === 'Debugger.paused') this.handlePaused(params)
      if (method === 'Debugger.resumed') this.handleResumed()
    })
    await client.send('Debugger.enable')
    await client.send('Runtime.enable')
    const first = request.targets[0]
    if (first === undefined) return
    const targetName = basename(first.path)
    const scriptId = await this.waitForScript(targetName, 10_000)
    const lines = new Set<number>()
    for (let line = first.startLine - 1; line <= first.endLine - 1; line += 1) lines.add(line)
    for (const line of lines) {
      const result = await client.send('Debugger.setBreakpoint', {
        location: { scriptId, lineNumber: line },
      })
      void result
    }
  }

  private recordScript(params: unknown): void {
    if (typeof params !== 'object' || params === null) return
    const record = params as { url?: unknown; scriptId?: unknown }
    if (typeof record.url === 'string' && typeof record.scriptId === 'string') {
      this.scripts.set(record.url, record.scriptId)
    }
  }

  private async waitForScript(targetName: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const [url, scriptId] of this.scripts) {
        if (url.endsWith(targetName)) return scriptId
      }
      await sleep(100)
    }
    throw new Error(`target script ${targetName} was never parsed`)
  }

  private handlePaused(params: unknown): void {
    const state = this.extractPause(params)
    if (state === undefined) return
    this.pause = state
    this.status = 'paused'
    this.settleAll(undefined, state)
  }

  /** The debugger left the paused state; drop the stale pause so later
   * commands wait for a fresh stop instead of acting on a resumed target. */
  private handleResumed(): void {
    this.pause = undefined
    this.status = 'waiting-for-reproduction'
  }

  /** Resolve the current paused frame, waiting up to the budget for a stop. */
  private async waitForPausedFrame(
    client: CdpClient,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const frameId = this.pause?.frames[0]?.callFrameId
      if (typeof frameId === 'string') return frameId
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      try {
        await client.waitForEvent('Debugger.paused', Math.min(remaining, 250))
      } catch {
        // A stop may land just after a wait window; keep polling until the budget ends.
      }
    }
  }

  private extractPause(params: unknown): PauseState | undefined {
    if (!isRecord(params)) return undefined
    const reason = params.reason
    const callFrames = params.callFrames
    if (typeof reason !== 'string' || !Array.isArray(callFrames)) return undefined
    const frames = callFrames.flatMap((frame) => {
      if (!isRecord(frame)) return []
      const functionName = frame.functionName
      const location = frame.location
      const callFrameId = frame.callFrameId
      if (typeof functionName !== 'string') return []
      if (!isRecord(location)) return []
      const lineNumber = location.lineNumber
      if (typeof lineNumber !== 'number') return []
      return [
        {
          functionName,
          lineNumber,
          ...(typeof callFrameId === 'string' ? { callFrameId } : {}),
        },
      ]
    })
    return { frames, reason }
  }

  private async step(
    action: string,
    request: DebugControlRequest,
  ): Promise<RuntimeControlOk | DebugRunError> {
    const client = this.client
    if (client === undefined) return error('NOT_READY', 'Node debugger is not attached.')
    this.pause = undefined
    this.status = 'waiting-for-reproduction'
    const pausePromise = this.awaitPause(request)
    try {
      const method =
        action === 'continue'
          ? 'Debugger.resume'
          : action === 'next'
            ? 'Debugger.stepOver'
            : action === 'step_in'
              ? 'Debugger.stepInto'
              : 'Debugger.stepOut'
      await client.send(method)
      return await pausePromise
    } catch (cause) {
      this.settleAll(cause)
      const message = cause instanceof Error ? cause.message : String(cause)
      return error('NOT_READY', message)
    }
  }

  private awaitPause(request: DebugControlRequest): Promise<RuntimeControlOk> {
    const timeout = Math.max(0, request.timeoutMs ?? 30_000)
    return new Promise<RuntimeControlOk>((ok) => {
      const timer = setTimeout(() => {
        this.waits.delete(waiter)
        ok(
          this.ok(
            'No breakpoint paused within the wait budget; reproduce the issue and retry wait.',
          ),
        )
      }, timeout)
      const waiter: WaitEntry = {
        resolve: (state) => {
          clearTimeout(timer)
          this.waits.delete(waiter)
          ok(this.ok(this.renderPaused(state)))
        },
        reject: () => {
          clearTimeout(timer)
          this.waits.delete(waiter)
        },
        timer,
      }
      this.waits.add(waiter)
    })
  }

  private settleAll(reason: unknown, state?: PauseState): void {
    for (const waiter of this.waits) {
      clearTimeout(waiter.timer)
      this.waits.delete(waiter)
      if (state !== undefined) waiter.resolve(state)
      else waiter.reject(reason)
    }
  }

  private renderEvaluate(result: unknown): string {
    if (!isRecord(result)) return String(result)
    const inner = result.result
    if (!isRecord(inner)) return JSON.stringify(result)
    const value = inner.value
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      return JSON.stringify(value)
    const description = inner.description
    return typeof description === 'string' ? description : JSON.stringify(result)
  }

  private renderPaused(state: PauseState): string {
    const frames = state.frames.map(
      (frame, index) => `${index}: ${frame.functionName} at line ${frame.lineNumber + 1}`,
    )
    return `Paused (${state.reason}).\n${frames.join('\n') || 'No frames.'}`
  }

  private statusResult(): RuntimeControlOk {
    return {
      kind: 'ok',
      status: this.status,
      text: `Node backend run ${this.runId} is ${this.status}.`,
    }
  }

  private ok(text: string): RuntimeControlOk {
    return { kind: 'ok', status: this.status, text }
  }
}
