import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FrontendRuntime } from '../../../src/runtime/frontend.ts'

const SOURCE = [
  'export function run(): number {',
  '  const value = 1',
  '  if (value > 0) {',
  '    return value',
  '  }',
  '  return 0',
  '}',
  '',
].join('\n')

describe('FrontendRuntime', () => {
  let directory: string
  let file: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-frontend-'))
    file = join(directory, 'a.ts')
    await writeFile(file, SOURCE, 'utf8')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('starts listener collection by default and keeps the local trace log on finish', async () => {
    const runtime = new FrontendRuntime('run-default')
    const started = await runtime.start({
      targets: [{ path: file, startLine: 2, endLine: 7 }],
      runtime: 'frontend',
    })
    if (started.kind !== 'ok') throw new Error('start failed')
    const tracePath = join(directory, '.dsh-debug/run-default/trace.jsonl')
    expect(started.notice).toContain('started the trace listener')
    expect(started.notice).toContain(tracePath)

    const instrumented = await readFile(file, 'utf8')
    expect(instrumented).toContain('globalThis.__dshTraceProbe')
    const runtimeSource = await readFile(
      join(directory, '.dsh-debug/run-default/trace-runtime.js'),
      'utf8',
    )
    expect(runtimeSource).toContain('/ingest')
    await expect(readFile(tracePath, 'utf8')).resolves.toBe('')

    const status = await runtime.control('status', { action: 'status' })
    if (status.kind !== 'ok') throw new Error('status failed')
    expect(status.text).toContain(tracePath)

    const wait = await runtime.control('wait', { action: 'wait', timeoutMs: 20 })
    if (wait.kind !== 'ok') throw new Error('wait failed')
    expect(wait.text).toContain('rotated')

    const read = await runtime.control('read', { action: 'read' })
    if (read.kind !== 'ok') throw new Error('read failed')
    expect(read.text).toBe('No trace events yet.')

    const finished = await runtime.finish('diagnosed')
    if (finished.kind !== 'ok') throw new Error('finish failed')
    expect(finished.summary).toContain(`saved to ${tracePath}`)
    expect(finished.restored).toContain(file)
    await expect(readFile(file, 'utf8')).resolves.toBe(SOURCE)
    await expect(
      readFile(join(directory, '.dsh-debug/run-default/trace-runtime.js'), 'utf8'),
    ).rejects.toThrow()
    await expect(readFile(tracePath, 'utf8')).resolves.toBe('')
  })

  it('supports explicit local-log output without starting a collector service', async () => {
    const runtime = new FrontendRuntime('run-local')
    const started = await runtime.start({
      targets: [{ path: file, startLine: 2, endLine: 7 }],
      runtime: 'frontend',
      traceTransport: 'local-log',
    })
    if (started.kind !== 'ok') throw new Error('start failed')
    expect(started.notice).toContain('local log output')
    expect(started.notice).toContain('no collector service was started')

    const runtimeSource = await readFile(
      join(directory, '.dsh-debug/run-local/trace-runtime.js'),
      'utf8',
    )
    expect(runtimeSource).not.toContain('/ingest')
    await expect(
      readFile(join(directory, '.dsh-debug/run-local/trace.jsonl'), 'utf8'),
    ).rejects.toThrow()

    const endpoint = await runtime.control('switch_endpoint', { action: 'switch_endpoint' })
    if (endpoint.kind !== 'error') throw new Error('expected endpoint rejection')
    expect(endpoint.code).toBe('UNSUPPORTED_ACTION')

    const finished = await runtime.finish('cancelled')
    if (finished.kind !== 'ok') throw new Error('finish failed')
    expect(finished.summary).toContain('no trace listener was started')
    await expect(readFile(file, 'utf8')).resolves.toBe(SOURCE)
  })

  it('fails loudly when a target cannot be read and rolls back', async () => {
    const runtime = new FrontendRuntime('run-missing')
    const started = await runtime.start({
      targets: [{ path: join(directory, 'missing.ts'), startLine: 1, endLine: 2 }],
      runtime: 'frontend',
    })
    expect(started).toMatchObject({ kind: 'error', code: 'INVALID_TARGETS' })
    await expect(readFile(file, 'utf8')).resolves.toBe(SOURCE)
  })

  it('requires the user to pick when a lan scope has several addresses', async () => {
    const runtime = new FrontendRuntime('scope-multi', [
      { family: 'IPv4', address: '192.168.1.7', internal: false },
      { family: 'IPv4', address: '10.0.0.8', internal: false },
    ])
    const started = await runtime.start({
      targets: [{ path: file, startLine: 2, endLine: 6 }],
      runtime: 'frontend',
      reproductionScope: 'lan',
    })
    expect(started).toMatchObject({ kind: 'error', code: 'CONFIRMATION_REQUIRED' })
    if (started.kind === 'error') {
      expect(started.message).toContain('192.168.1.7')
      expect(started.message).toContain('10.0.0.8')
      expect(started.message).toContain('lanAddress')
    }
    await expect(readFile(file, 'utf8')).resolves.toBe(SOURCE)
  })

  it('uses the chosen lan address and advertises loopback for explicit local listeners', async () => {
    const views = [{ family: 'IPv4', address: '192.168.1.7', internal: false }]
    const lan = new FrontendRuntime('scope-lan-one', views)
    const lanStarted = await lan.start({
      targets: [{ path: file, startLine: 2, endLine: 6 }],
      runtime: 'frontend',
      reproductionScope: 'lan',
    })
    if (lanStarted.kind !== 'ok') throw new Error(`lan start failed: ${lanStarted.message}`)
    expect(lanStarted.notice).toContain('192.168.1.7')
    await lan.finish('cancelled')
    await expect(readFile(file, 'utf8')).resolves.toBe(SOURCE)

    const local = new FrontendRuntime('scope-local')
    const localStarted = await local.start({
      targets: [{ path: file, startLine: 2, endLine: 6 }],
      runtime: 'frontend',
      traceTransport: 'listener',
      reproductionScope: 'local',
    })
    if (localStarted.kind !== 'ok') throw new Error(`local start failed: ${localStarted.message}`)
    expect(localStarted.notice).toContain('127.0.0.1')
    await local.finish('cancelled')
    await expect(readFile(file, 'utf8')).resolves.toBe(SOURCE)
  })

  it('rejects a listener address when local-log transport is explicit', async () => {
    const runtime = new FrontendRuntime('scope-conflict')
    const started = await runtime.start({
      targets: [{ path: file, startLine: 2, endLine: 6 }],
      runtime: 'frontend',
      traceTransport: 'local-log',
      lanAddress: '192.168.1.7',
    })
    expect(started).toMatchObject({ kind: 'error', code: 'INVALID_TARGETS' })
    if (started.kind === 'error') expect(started.message).toContain('traceTransport "listener"')
    await expect(readFile(file, 'utf8')).resolves.toBe(SOURCE)
  })
})
