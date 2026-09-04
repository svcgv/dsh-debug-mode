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

  it('instruments, reports status, and restores on finish', async () => {
    const runtime = new FrontendRuntime('run-front')
    const started = await runtime.start({
      targets: [{ path: file, startLine: 2, endLine: 7 }],
      runtime: 'frontend',
    })
    if (started.kind !== 'ok') throw new Error('start failed')
    expect(started.notice).toContain('Reproduce the issue now')

    const instrumented = await readFile(file, 'utf8')
    expect(instrumented).toContain('globalThis.__dshTraceProbe')
    expect(instrumented).toContain('.dsh-debug/run-front/trace-runtime.js')
    expect(
      await readFile(join(directory, '.dsh-debug/run-front/trace-runtime.js'), 'utf8'),
    ).toContain('__dshTraceProbe')

    const status = await runtime.control('status', { action: 'status' })
    if (status.kind !== 'ok') throw new Error('status failed')
    expect(status.text).toContain('run-front')

    const wait = await runtime.control('wait', { action: 'wait', timeoutMs: 20 })
    if (wait.kind !== 'ok') throw new Error('wait failed')
    expect(wait.text).toContain('No new trace events')

    const read = await runtime.control('read', { action: 'read' })
    if (read.kind !== 'ok') throw new Error('read failed')
    expect(read.text).toBe('No trace events yet.')

    const rotated = await runtime.control('switch_endpoint', { action: 'switch_endpoint' })
    if (rotated.kind !== 'ok') throw new Error('rotate failed')
    expect(rotated.text).toContain('rotated')

    const reinst = await runtime.control('reinstrument', { action: 'reinstrument' })
    if (reinst.kind !== 'ok') throw new Error('reinstrument failed')
    expect(reinst.text).toContain('next debug_start')

    const unsupported = await runtime.control('continue', { action: 'continue' })
    if (unsupported.kind !== 'error') throw new Error('expected unsupported')
    expect(unsupported.code).toBe('UNSUPPORTED_ACTION')

    const finished = await runtime.finish('diagnosed')
    if (finished.kind !== 'ok') throw new Error('finish failed')
    expect(finished.restored).toContain(file)
    await expect(readFile(file, 'utf8')).resolves.toBe(SOURCE)
    await expect(
      readFile(join(directory, '.dsh-debug/run-front/trace-runtime.js'), 'utf8'),
    ).rejects.toThrow()
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
})
