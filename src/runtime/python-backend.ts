/**
 * Python backend debug runtime for long-running services using debugpy over
 * the Debug Adapter Protocol. A free port is reserved, the service starts
 * under `python -m debugpy --listen --wait-for-client`, and the DAP client
 * attaches, sets line breakpoints, and drives stepping.
 *
 * @module dsh-debug-mode/runtime/python-backend
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { connect, createServer, type Socket } from 'node:net'
import { dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { DapClient } from './dap.ts'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function error(code: DebugRunError['code'], message: string): DebugRunError {
  return { kind: 'error', code, message, retryable: false }
}

/** Whether python3 can import debugpy. */
export function hasDebugpy(python = 'python3'): Promise<boolean> {
  return new Promise((ok) => {
    execFile(python, ['-c', 'import debugpy'], (execError) => ok(execError === null))
  })
}

/** Reserve an ephemeral TCP port for the debug adapter. */
export function reservePort(): Promise<number> {
  return new Promise<number>((ok, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        fail(new Error('could not reserve a port'))
        return
      }
      const port = address.port
      server.close(() => ok(port))
    })
  })
}

interface StopState {
  readonly threadId: number
  readonly reason: string
}

/** Pick the client-facing debuggee DAP socket from a `debugpySockets` body.
 * debugpy's `--listen` port is an adapter control channel; the actual DAP
 * session runs on the reported non-internal socket. Falls back to the listen
 * port for debugpy builds that expose DAP directly there.
 */
export function pickDebuggeeSocketPort(value: unknown, fallback: number): number {
  if (isRecord(value) && Array.isArray(value.sockets)) {
    for (const candidate of value.sockets) {
      if (
        isRecord(candidate) &&
        candidate.internal !== true &&
        typeof candidate.port === 'number'
      ) {
        return candidate.port
      }
    }
  }
  return fallback
}

/** One running Python debug session for a long-lived service. */
export class PythonBackendRuntime implements DebugRuntime {
  readonly kind = 'backend' as const
  private child: ChildProcess | undefined
  private socket: Socket | undefined
  private client: DapClient | undefined
  private stop: StopState | undefined
  private status: 'waiting-for-reproduction' | 'paused' | 'diagnosing' = 'waiting-for-reproduction'

  constructor(
    private readonly runId: string,
    private readonly python = 'python3',
  ) {}

  async start(request: DebugStartRequest): Promise<RuntimeStartOk | DebugRunError> {
    const first = request.targets[0]
    if (first === undefined)
      return error('INVALID_TARGETS', 'debug_start requires at least one target file.')
    const script = resolve(first.path)
    if (!script.endsWith('.py'))
      return error('UNSUPPORTED_TARGET', 'The Python backend supports .py service files.')
    if (!(await hasDebugpy(this.python))) {
      return error(
        'RUNTIME_UNAVAILABLE',
        'debugpy is not installed in this Python environment; install it (pip install debugpy) before starting a Python debug run.',
      )
    }
    let port = 0
    try {
      port = await reservePort()
    } catch (cause) {
      return error(
        'INVALID_TARGETS',
        `Could not reserve a debug port: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    const child = spawn(
      this.python,
      ['-m', 'debugpy', '--listen', `127.0.0.1:${port}`, '--wait-for-client', script],
      {
        cwd: dirname(script),
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    this.child = child
    try {
      await this.attach(port, request)
      return {
        kind: 'ok',
        kindOfRun: 'backend',
        status: 'waiting-for-reproduction',
        notice: `Started the Python service under debugpy with breakpoints set. Reproduce the issue now.`,
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.client?.close()
      this.client = undefined
      this.socket?.destroy()
      this.socket = undefined
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      this.child = undefined
      return error('INVALID_TARGETS', `Could not attach debugpy: ${message}`)
    }
  }

  async control(
    action: string,
    request: DebugControlRequest,
  ): Promise<RuntimeControlOk | DebugRunError> {
    const client = this.client
    if (client === undefined) return error('NOT_READY', 'Python debugger is not attached.')
    switch (action) {
      case 'status':
        return {
          kind: 'ok',
          status: this.status,
          text: `Python backend run ${this.runId} is ${this.status}.`,
        }
      case 'wait':
        return this.awaitStop(client, request)
      case 'continue':
      case 'next':
      case 'step_in':
      case 'step_out': {
        const threadId = this.stop?.threadId
        if (threadId === undefined)
          return error('NOT_READY', 'No paused thread; reproduce the issue first.')
        this.stop = undefined
        this.status = 'waiting-for-reproduction'
        const command =
          action === 'continue'
            ? 'continue'
            : action === 'next'
              ? 'next'
              : action === 'step_in'
                ? 'stepIn'
                : 'stepOut'
        const args: Record<string, unknown> = { threadId }
        const stoppedPromise = this.awaitStop(client, request)
        await client.send(command, args)
        return stoppedPromise
      }
      case 'evaluate': {
        const expression = request.expression
        if (expression === undefined || expression === '')
          return error('INVALID_TARGETS', 'evaluate requires an expression.')
        const frameResult = await client.send('stackTrace', {
          threadId: this.stop?.threadId ?? 0,
          levels: 1,
        })
        const stackFrames = isRecord(frameResult) ? frameResult.stackFrames : undefined
        const firstFrame: unknown = Array.isArray(stackFrames) ? stackFrames[0] : undefined
        const frameId = isRecord(firstFrame) ? firstFrame.id : undefined
        if (typeof frameId !== 'number')
          return error('NOT_READY', 'No paused frame for evaluation.')
        const result = await client.send('evaluate', { expression, frameId })
        const value = isRecord(result) ? result.result : undefined
        return this.ok(this.renderValue(value))
      }
      default:
        return error('UNSUPPORTED_ACTION', `Python backend does not support action "${action}".`)
    }
  }

  async finish(outcome: DebugFinishOutcome): Promise<RuntimeFinishOk | DebugRunError> {
    if (this.client !== undefined && !this.client.isClosed) {
      try {
        await this.client.send('disconnect', { terminateDebuggee: true })
      } catch {
        // process teardown below is authoritative
      }
    }
    this.client?.close()
    this.client = undefined
    this.socket?.destroy()
    this.socket = undefined
    const child = this.child
    this.child = undefined
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
      summary: `Finished ${outcome}: stopped the Python debug process and released the session.`,
    }
  }

  private async attach(port: number, request: DebugStartRequest): Promise<void> {
    const socket = await connectWithRetry(port, this.child)
    this.socket = socket
    const client = new DapClient({ write: (data) => socket.write(data), close: () => socket.end() })
    socket.on('data', (chunk) => client.feed(chunk))
    this.client = client
    let socketsBody: unknown
    client.onEvent((event, body) => {
      if (event === 'debugpySockets') socketsBody = body
      if (event === 'stopped' && typeof body === 'object' && body !== null) {
        const record = body as { reason?: unknown; threadId?: unknown }
        if (typeof record.reason === 'string' && typeof record.threadId === 'number') {
          this.stop = { threadId: record.threadId, reason: record.reason }
          this.status = 'paused'
        }
      }
    })
    await client.send('initialize', {
      adapterID: 'debugpy',
      clientID: 'dsh-debug-mode',
      supportsVariableType: false,
    })
    if (socketsBody === undefined) {
      try {
        await client.waitForEvent('debugpySockets', 5_000)
      } catch {
        // Older debugpy builds expose DAP directly on the listen port.
      }
    }
    const debuggeePort = pickDebuggeeSocketPort(socketsBody, port)
    // debugpy defers the attach response until configurationDone, so the
    // attach request must be pipelined ahead of the remaining handshake.
    const attaching = client.send('attach', { port: debuggeePort, pathMappings: [] })
    const first = request.targets[0]
    if (first !== undefined) {
      await client.send('setBreakpoints', {
        source: { path: resolve(first.path) },
        breakpoints: Array.from({ length: first.endLine - first.startLine + 1 }, (_, index) => ({
          line: first.startLine + index,
        })),
      })
    }
    await client.send('configurationDone')
    await attaching
  }

  private async awaitStop(
    client: DapClient,
    request: DebugControlRequest,
  ): Promise<RuntimeControlOk> {
    if (this.stop !== undefined)
      return this.ok(`Stopped (${this.stop.reason}) on thread ${this.stop.threadId}.`)
    const timeout = Math.max(0, request.timeoutMs ?? 30_000)
    try {
      const body = await client.waitForEvent('stopped', timeout)
      if (typeof body !== 'object' || body === null) return this.ok('Stopped.')
      const record = body as { reason?: unknown; threadId?: unknown }
      if (typeof record.reason !== 'string' || typeof record.threadId !== 'number')
        return this.ok('Stopped.')
      this.stop = { threadId: record.threadId, reason: record.reason }
      this.status = 'paused'
      return this.ok(`Stopped (${record.reason}) on thread ${record.threadId}.`)
    } catch {
      return this.ok(
        'No breakpoint stopped within the wait budget; reproduce the issue and retry wait.',
      )
    }
  }

  private renderValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value ?? null)
  }

  private ok(text: string): RuntimeControlOk {
    return { kind: 'ok', status: this.status, text }
  }
}

async function connectWithRetry(port: number, child: ChildProcess | undefined): Promise<Socket> {
  const deadline = Date.now() + 15_000
  for (;;) {
    if (child !== undefined && child.exitCode !== null && child.signalCode !== null) {
      throw new Error('debugpy exited before the adapter connected')
    }
    try {
      return await new Promise<Socket>((ok, fail) => {
        const connection = connect({ host: '127.0.0.1', port })
        connection.once('connect', () => ok(connection))
        connection.once('error', fail)
      })
    } catch {
      if (Date.now() >= deadline) throw new Error('timed out connecting to debugpy')
      await new Promise((ok) => setTimeout(ok, 200))
    }
  }
}
