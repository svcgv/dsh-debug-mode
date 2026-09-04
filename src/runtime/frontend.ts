/**
 * Frontend debug runtime adapter: starts the authenticated trace listener,
 * instruments the located JS/TS files, ships a project-local trace runtime,
 * and exposes bounded evidence reads plus endpoint rotation. Everything the
 * adapter changes is owned by the run id so finish can remove it safely.
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
import { DEFAULT_STORE_LIMITS, TraceStore, type TraceCursor } from '../listener/store.ts'
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
} from '../run/types.ts'
import { endpointCandidates } from './endpoints.ts'
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

function parseTarget(value: unknown): DebugTarget | undefined {
  if (!isRecord(value) || typeof value.path !== 'string') return undefined
  const startLine = value.startLine
  const endLine = value.endLine
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return undefined
  return { path: value.path, startLine, endLine }
}

/** One live frontend run owned by the manager. */
export class FrontendRuntime implements DebugRuntime {
  readonly kind = 'frontend' as const
  private readonly runId: string
  private readonly store = new TraceStore(DEFAULT_STORE_LIMITS)
  private readonly token = randomBytes(24).toString('base64url')
  private readonly files: ManagedFile[] = []
  private server: Server | undefined
  private port = 0
  private runtimeDirectory = ''
  private runtimePath = ''
  private endpoints: readonly string[] = []
  private status: 'waiting-for-reproduction' | 'paused' | 'diagnosing' = 'waiting-for-reproduction'
  private endpointsRotated = false

  constructor(runId: string) {
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
      await this.startListener()
      const firstDirectory = dirname(resolve(resolvedTargets[0]?.path ?? '.'))
      this.runtimeDirectory = join(firstDirectory, '.dsh-debug', this.runId)
      this.runtimePath = join(this.runtimeDirectory, 'trace-runtime.js')
      await mkdir(this.runtimeDirectory, { recursive: true })
      await writeFile(
        this.runtimePath,
        createTraceRuntimeSource({
          runId: this.runId,
          token: this.token,
          endpoints: this.endpoints,
          projectPath: resolvedTargets[0]?.path ?? '',
        }),
        'utf8',
      )
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
      const notice = classic
        ? `Instrumented ${resolvedTargets.length} file(s) and started the trace listener at ${this.endpoints[0]}. ` +
          'The project has classic scripts, so load the trace runtime file before the app runs, then reproduce the issue.'
        : `Instrumented ${resolvedTargets.length} file(s) and started the trace listener at ${this.endpoints[0]}. Reproduce the issue now.`
      return { kind: 'ok', kindOfRun: 'frontend', status: 'waiting-for-reproduction', notice }
    } catch (cause) {
      await this.rollback()
      const message = cause instanceof Error ? cause.message : String(cause)
      return error('INVALID_TARGETS', `Frontend instrumentation failed: ${message}`)
    }
  }

  async control(
    action: string,
    request: DebugControlRequest,
  ): Promise<RuntimeControlOk | DebugRunError> {
    switch (action) {
      case 'status':
        return this.statusResult()
      case 'wait': {
        const cursor = this.parseCursor(request.cursor)
        const target = cursor + 1
        const timeout = Math.max(0, request.timeoutMs ?? 15_000)
        const ready = await this.store.waitFor(target, timeout)
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
        if (this.store.count === 0 && !this.endpointsRotated) {
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
        const page = this.store.read(cursor, 200)
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
        await writeFile(
          this.runtimePath,
          createTraceRuntimeSource({
            runId: this.runId,
            token: this.token,
            endpoints: rotated,
            projectPath: '',
          }),
          'utf8',
        )
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
    if (this.runtimeDirectory !== '') {
      try {
        await rm(this.runtimeDirectory, { recursive: true, force: true })
      } catch {
        couldNotRestore.push(this.runtimeDirectory)
      }
    }
    await this.closeListener()
    return {
      kind: 'ok',
      status: 'finished',
      restored,
      couldNotRestore,
      summary: `Finished ${outcome}: removed ${restored.length} instrumented file(s) and stopped the trace listener.`,
    }
  }

  private statusResult(): RuntimeControlOk {
    const endpoint = this.endpointsRotated
      ? (this.endpoints[1] ?? this.endpoints[0])
      : this.endpoints[0]
    return {
      kind: 'ok',
      status: this.status,
      cursor: String(this.store.count - 1),
      text: `Frontend run ${this.runId}: ${this.store.count} events (${this.store.droppedCount} dropped), listener ${endpoint ?? 'stopped'}.`,
    }
  }

  private async startListener(): Promise<void> {
    const server = createServer(createIngestHandler({ store: this.store, token: this.token }))
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '0.0.0.0', () => resolvePromise())
    })
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('listener did not bind a TCP port')
    this.server = server
    this.port = address.port
    const ifaces = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    const views = ifaces.map((entry) => ({
      family: entry.family,
      address: entry.address,
      internal: entry.internal,
    }))
    this.endpoints = endpointCandidates(views, this.port)
  }

  private async rotateRuntimeEndpoints(): Promise<void> {
    this.endpointsRotated = true
    const firstEndpoint = this.endpoints[0]
    const rotated = firstEndpoint === undefined ? [] : [...this.endpoints.slice(1), firstEndpoint]
    await writeFile(
      this.runtimePath,
      createTraceRuntimeSource({
        runId: this.runId,
        token: this.token,
        endpoints: rotated,
        projectPath: '',
      }),
      'utf8',
    )
  }

  private parseCursor(value: string | undefined): TraceCursor {
    if (value === undefined) return -1
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : -1
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

  private async rollback(): Promise<void> {
    const writes = this.files.map(async (file) => {
      try {
        await writeFile(file.path, file.original, 'utf8')
      } catch {
        // best-effort rollback; finish reports what could not be restored
      }
    })
    await Promise.all(writes)
    if (this.runtimeDirectory !== '') {
      try {
        await rm(this.runtimeDirectory, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
    await this.closeListener()
  }
}
