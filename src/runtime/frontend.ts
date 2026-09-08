/**
 * Frontend debug runtime adapter: starts the authenticated trace listener by
 * default, instruments located JS/TS files, persists collected events to a
 * run-owned local JSONL log, and retains local-only output as an explicit
 * opt-out. Everything the adapter changes is owned by the run id so finish can
 * remove or report it safely.
 *
 * @module dsh-debug-mode/runtime/frontend
 */

import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  addRuntimeImport,
  instrumentJavaScript,
  removeInstrumentation,
} from '../instrumentation/js.ts'
import { createIngestHandler } from '../listener/http.ts'
import {
  DEFAULT_STORE_LIMITS,
  TraceStore,
  TraceStoreError,
  type TraceCursor,
} from '../listener/store.ts'
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
  DebugTarget,
  FrontendTraceTransport,
} from '../run/types.ts'
import { resolveEndpointPlan } from './endpoints.ts'
import { createTraceRuntimeSource } from './source.ts'

interface ManagedFile {
  readonly path: string
  readonly original: string
  readonly classic: boolean
}

function error(code: DebugRunError['code'], message: string): DebugRunError {
  return { kind: 'error', code, message, retryable: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function parseTarget(value: unknown): DebugTarget | undefined {
  if (!isRecord(value) || typeof value.path !== 'string') return undefined
  const startLine = value.startLine
  const endLine = value.endLine
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return undefined
  return { path: value.path, startLine, endLine }
}

function selectTraceTransport(request: DebugStartRequest): FrontendTraceTransport {
  return request.traceTransport ?? 'listener'
}

/** One live frontend run owned by the manager. */
export class FrontendRuntime implements DebugRuntime {
  readonly kind = 'frontend' as const
  private readonly runId: string
  private readonly files: ManagedFile[] = []
  private store: TraceStore | undefined
  private traceTransport: FrontendTraceTransport = 'listener'
  private readonly token = randomBytes(24).toString('base64url')
  private server: Server | undefined
  private port = 0
  private runtimeDirectory = ''
  private runtimeDirectoryOwned = false
  private runtimePath = ''
  private traceLogPath = ''
  private endpoints: readonly string[] = []
  private endpointNotice = ''
  private status: 'waiting-for-reproduction' | 'paused' | 'diagnosing' = 'waiting-for-reproduction'
  private endpointsRotated = false

  constructor(
    runId: string,
    private readonly interfaceViews?: ReadonlyArray<{
      readonly family: string
      readonly address: string
      readonly internal: boolean
    }>,
  ) {
    this.runId = runId
  }

  async start(request: DebugStartRequest): Promise<RuntimeStartOk | DebugRunError> {
    const resolvedTargets: DebugTarget[] = []
    for (const raw of request.targets) {
      const target = parseTarget(raw)
      if (target === undefined)
        return error(
          'INVALID_TARGETS',
          'Every frontend target needs a path and a valid line range.',
        )
      resolvedTargets.push(target)
    }
    try {
      this.traceTransport = selectTraceTransport(request)
      if (this.traceTransport === 'local-log' && request.lanAddress !== undefined) {
        return error(
          'INVALID_TARGETS',
          'lanAddress can only be used with traceTransport "listener".',
        )
      }
      const firstDirectory = dirname(resolve(resolvedTargets[0]?.path ?? '.'))
      this.runtimeDirectory = join(firstDirectory, '.dsh-debug', this.runId)
      this.runtimePath = join(this.runtimeDirectory, 'trace-runtime.js')
      this.traceLogPath = join(this.runtimeDirectory, 'trace.jsonl')
      await mkdir(dirname(this.runtimeDirectory), { recursive: true })
      try {
        await mkdir(this.runtimeDirectory)
        this.runtimeDirectoryOwned = true
      } catch (cause) {
        if (isNodeError(cause) && cause.code === 'EEXIST') {
          throw new TraceStoreError(
            'TRACE_LOG_EXISTS',
            `The run directory ${this.runtimeDirectory} already exists; refusing to overwrite it. Use a new run id or recover the existing run explicitly.`,
            { cause },
          )
        }
        throw cause
      }
      if (this.traceTransport === 'listener') {
        this.store = new TraceStore(DEFAULT_STORE_LIMITS, this.traceLogPath)
        await this.store.initialize()
        await this.startListener()
        const views = this.collectInterfaceViews()
        const plan = resolveEndpointPlan(
          views,
          this.port,
          request.reproductionScope ?? 'auto',
          request.lanAddress,
        )
        if (plan.kind === 'lan-selection-required') {
          await this.rollback()
          return error(
            'CONFIRMATION_REQUIRED',
            `The reproduction target is another device, and this machine has ${plan.candidates.length} LAN addresses: ${plan.candidates.join(', ')}. ` +
              'Show the user the candidates, ask which one the device can reach, and call debug_start again with "lanAddress": "<chosen>".',
          )
        }
        if (plan.kind === 'no-lan') {
          await this.rollback()
          return error(
            'RUNTIME_UNAVAILABLE',
            'The reproduction target is another device, but this machine has no non-loopback IPv4 address to advertise.',
          )
        }
        if (plan.kind === 'invalid-lan') {
          await this.rollback()
          return error(
            'INVALID_TARGETS',
            `lanAddress ${plan.requested} is not a current LAN address of this machine (${plan.candidates.join(', ') || 'none'}).`,
          )
        }
        this.endpoints = plan.endpoints
        this.endpointNotice = plan.notice
      }
      await writeFile(this.runtimePath, this.runtimeSource(resolvedTargets[0]?.path ?? ''), 'utf8')
      const sources = await Promise.all(
        resolvedTargets.map(async (target) => ({
          target,
          source: await readFile(resolve(target.path), 'utf8'),
        })),
      )
      const pendingWrites: Array<Promise<void>> = []
      for (const { target, source } of sources) {
        const absolute = resolve(target.path)
        const instrumented = instrumentJavaScript(source, {
          runId: this.runId,
          projectPath: target.path,
          startLine: target.startLine,
          endLine: target.endLine,
        })
        const relativeRuntime = relative(dirname(absolute), this.runtimePath).split(sep).join('/')
        const withImport = addRuntimeImport(instrumented.code, relativeRuntime, this.runId)
        this.files.push({ path: absolute, original: source, classic: !withImport.changed })
        pendingWrites.push(
          writeFile(absolute, withImport.changed ? withImport.code : instrumented.code, 'utf8'),
        )
      }
      await Promise.all(pendingWrites)
      const classic = this.files.some((file) => file.classic)
      const notice = this.startNotice(resolvedTargets.length, classic)
      return { kind: 'ok', kindOfRun: 'frontend', status: 'waiting-for-reproduction', notice }
    } catch (cause) {
      await this.rollback()
      if (cause instanceof TraceStoreError) {
        return error(
          cause.code === 'TRACE_LOG_EXISTS' ? 'TRACE_LOG_EXISTS' : 'TRACE_PERSISTENCE_FAILED',
          `Frontend trace persistence failed (${cause.code}): ${cause.message}`,
        )
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      return error('INVALID_TARGETS', `Frontend instrumentation failed: ${message}`)
    }
  }

  async control(
    action: string,
    request: DebugControlRequest,
  ): Promise<RuntimeControlOk | DebugRunError> {
    if (this.traceTransport === 'local-log') return this.controlLocalLog(action)
    switch (action) {
      case 'status':
        return this.statusResult()
      case 'wait': {
        const cursor = this.parseCursor(request.cursor)
        const target = cursor + 1
        const timeout = Math.max(0, request.timeoutMs ?? 15_000)
        const ready = await this.requireStore().waitFor(target, timeout)
        if (ready) {
          return {
            kind: 'ok',
            status: this.status,
            cursor: String(target - 1),
            text: 'New trace events arrived; call debug_control read to fetch them.',
          }
        }
        // A runtime that loaded sends a heartbeat immediately. No events at
        // all means the loopback endpoint was unreachable, so rotate to the
        // LAN candidate automatically and ask for a reload.
        if (this.requireStore().count === 0 && !this.endpointsRotated) {
          await this.rotateRuntimeEndpoints()
          return {
            kind: 'ok',
            status: this.status,
            cursor: String(target - 1),
            text: `No heartbeat reached the loopback listener; rotated the trace endpoint. Reload or re-run the app so it reports to ${this.endpoints[this.endpointsRotated ? 1 : 0] ?? this.endpoints[0]}.`,
          }
        }
        return {
          kind: 'ok',
          status: this.status,
          cursor: String(target - 1),
          text: 'No new trace events arrived within the wait budget.',
        }
      }
      case 'read': {
        const cursor = this.parseCursor(request.cursor)
        const page = this.requireStore().read(cursor, 200)
        const lines = page.events.map((entry) => JSON.stringify(entry)).join('\n')
        return {
          kind: 'ok',
          status: this.status,
          cursor: String(page.nextCursor),
          text: lines === '' ? 'No trace events yet.' : lines,
        }
      }
      case 'switch_endpoint': {
        this.endpointsRotated = true
        const firstEndpoint = this.endpoints[0]
        const rotated =
          firstEndpoint === undefined ? [] : [...this.endpoints.slice(1), firstEndpoint]
        await writeFile(this.runtimePath, this.runtimeSource('', rotated), 'utf8')
        return {
          kind: 'ok',
          status: this.status,
          text: `Trace endpoint rotated; reload or re-run the app so it reports to ${rotated[0]}.`,
        }
      }
      case 'reinstrument':
        return {
          kind: 'ok',
          status: this.status,
          text: 'Reinstrumentation applies on the next debug_start; no target changed since launch.',
        }
      default:
        return error('UNSUPPORTED_ACTION', `Frontend runs do not support action "${action}".`)
    }
  }

  async finish(outcome: DebugFinishOutcome): Promise<RuntimeFinishOk | DebugRunError> {
    const restored: string[] = []
    const couldNotRestore: string[] = []
    const cleanups = this.files.map(async (file) => {
      try {
        const current = await readFile(file.path, 'utf8')
        const cleaned = removeInstrumentation(current, this.runId)
        await writeFile(file.path, cleaned.code, 'utf8')
        restored.push(file.path)
      } catch {
        couldNotRestore.push(file.path)
      }
    })
    await Promise.all(cleanups)
    if (this.runtimePath !== '') {
      try {
        await rm(this.runtimePath, { force: true })
      } catch {
        couldNotRestore.push(this.runtimePath)
      }
    }
    await this.closeListener()
    await this.closeStore()
    if (this.traceTransport === 'local-log' && this.runtimeDirectoryOwned) {
      try {
        await rm(this.runtimeDirectory, { recursive: true, force: true })
      } catch {
        couldNotRestore.push(this.runtimeDirectory)
      }
    }
    const transportSummary =
      this.traceTransport === 'listener'
        ? ` and stopped the trace listener. Collected events are saved to ${this.traceLogPath}.`
        : '; no trace listener was started.'
    return {
      kind: 'ok',
      status: 'finished',
      restored,
      couldNotRestore,
      summary: `Finished ${outcome}: removed ${restored.length} instrumented file(s)${transportSummary}`,
    }
  }

  private startNotice(targetCount: number, classic: boolean): string {
    if (this.traceTransport === 'local-log') {
      const load = classic
        ? ' The project has classic scripts, so load the trace runtime file before the app runs.'
        : ''
      return (
        `Instrumented ${targetCount} file(s) for local log output; no collector service was started.${load} ` +
        `Reproduce the issue and inspect the application console or terminal for lines prefixed [dsh-debug:${this.runId}]. ` +
        'Paste those lines into the session if they are not already visible to the agent.'
      )
    }
    const location = this.endpointNotice === '' ? '' : `${this.endpointNotice} `
    return classic
      ? `${location}Instrumented ${targetCount} file(s) and started the trace listener at ${this.endpoints[0]}. ` +
          `Collected events are saved to ${this.traceLogPath}. The project has classic scripts, so load the trace runtime file before the app runs, then reproduce the issue.`
      : `${location}Instrumented ${targetCount} file(s) and started the trace listener at ${this.endpoints[0]}. Collected events are saved to ${this.traceLogPath}. Reproduce the issue now.`
  }

  private controlLocalLog(action: string): RuntimeControlOk | DebugRunError {
    const prefix = `[dsh-debug:${this.runId}]`
    switch (action) {
      case 'status':
        return {
          kind: 'ok',
          status: this.status,
          text: `Frontend run ${this.runId}: local-log transport active, no listener service running. Evidence prefix: ${prefix}.`,
        }
      case 'wait':
        return {
          kind: 'ok',
          status: this.status,
          text: `Local-log transport does not collect events. Reproduce the issue, then inspect the application console or terminal for ${prefix} lines.`,
        }
      case 'read':
        return {
          kind: 'ok',
          status: this.status,
          text: `Evidence remains in the application console or terminal. Read or paste the bounded ${prefix} lines; Debug Mode did not start a collector service.`,
        }
      case 'reinstrument':
        return {
          kind: 'ok',
          status: this.status,
          text: 'Reinstrumentation applies on the next debug_start; no target changed since launch.',
        }
      case 'switch_endpoint':
        return error(
          'UNSUPPORTED_ACTION',
          'Local-log transport has no network endpoint. Start a new frontend run with traceTransport "listener" to collect events automatically.',
        )
      default:
        return error('UNSUPPORTED_ACTION', `Frontend runs do not support action "${action}".`)
    }
  }

  private statusResult(): RuntimeControlOk {
    const endpoint = this.endpointsRotated
      ? (this.endpoints[1] ?? this.endpoints[0])
      : this.endpoints[0]
    return {
      kind: 'ok',
      status: this.status,
      cursor: String(this.requireStore().count - 1),
      text: `Frontend run ${this.runId}: ${this.requireStore().count} events (${this.requireStore().droppedCount} dropped), listener ${endpoint ?? 'stopped'}, saved to ${this.traceLogPath}.`,
    }
  }

  private async startListener(): Promise<void> {
    const server = createServer(
      createIngestHandler({ store: this.requireStore(), token: this.token }),
    )
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '0.0.0.0', () => resolvePromise())
    })
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('listener did not bind a TCP port')
    this.server = server
    this.port = address.port
  }

  /** Shape the current interface table into endpoint-plan input. Tests inject
   * a fixed table through the constructor seam. */
  private collectInterfaceViews(): ReadonlyArray<{
    readonly family: string
    readonly address: string
    readonly internal: boolean
  }> {
    if (this.interfaceViews !== undefined) return this.interfaceViews
    const ifaces = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    return ifaces.map((entry) => ({
      family: entry.family,
      address: entry.address,
      internal: entry.internal,
    }))
  }

  private async rotateRuntimeEndpoints(): Promise<void> {
    this.endpointsRotated = true
    const firstEndpoint = this.endpoints[0]
    const rotated = firstEndpoint === undefined ? [] : [...this.endpoints.slice(1), firstEndpoint]
    await writeFile(this.runtimePath, this.runtimeSource('', rotated), 'utf8')
  }

  private runtimeSource(projectPath: string, endpoints = this.endpoints): string {
    if (this.traceTransport === 'local-log') {
      return createTraceRuntimeSource({
        transport: 'local-log',
        runId: this.runId,
        projectPath,
      })
    }
    return createTraceRuntimeSource({
      transport: 'listener',
      runId: this.runId,
      token: this.token,
      endpoints,
      projectPath,
    })
  }

  private parseCursor(value: string | undefined): TraceCursor {
    if (value === undefined) return -1
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : -1
  }

  private requireStore(): TraceStore {
    if (this.store === undefined) {
      throw new TraceStoreError(
        'TRACE_STORE_NOT_READY',
        'The frontend listener store is not available for this run.',
      )
    }
    return this.store
  }

  private async closeListener(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>((resolvePromise, reject) => {
      server.close((closeError) =>
        closeError === undefined ? resolvePromise() : reject(closeError),
      )
    })
  }

  private async closeStore(): Promise<void> {
    const store = this.store
    if (store === undefined) return
    await store.close()
    this.store = undefined
  }

  private async rollback(): Promise<void> {
    await this.closeListener()
    await this.closeStore()
    const writes = this.files.map(async (file) => {
      try {
        await writeFile(file.path, file.original, 'utf8')
      } catch {
        // best-effort rollback; finish reports what could not be restored
      }
    })
    await Promise.all(writes)
    if (this.runtimeDirectoryOwned) {
      try {
        await rm(this.runtimeDirectory, { recursive: true, force: true })
        this.runtimeDirectoryOwned = false
      } catch {
        // best-effort
      }
    }
  }
}
