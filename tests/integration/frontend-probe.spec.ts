import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrontendRuntime } from '../../src/runtime/frontend.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SCRIPT = [
  'function add(a, b) {',
  '  const sum = a + b',
  '  if (sum > 10) {',
  '    return sum',
  '  }',
  '  return 0',
  '}',
  'add(5, 20)',
  '',
].join('\n')

describe('FrontendRuntime probe round trip (real listener)', () => {
  let directory: string
  let file: string
  let runtime: FrontendRuntime

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-frontend-e2e-'))
    file = join(directory, 'app.js')
    await writeFile(file, SCRIPT, 'utf8')
    runtime = new FrontendRuntime('run-e2e')
    const started = await runtime.start({
      targets: [{ path: file, startLine: 1, endLine: 6 }],
      runtime: 'frontend',
    })
    if (started.kind !== 'ok') throw new Error(`start failed: ${started.message}`)
  })

  afterAll(async () => {
    if (runtime !== undefined) {
      const finished = await runtime.finish('diagnosed').catch(() => undefined)
      if (finished?.kind !== 'ok' && finished !== undefined) {
        throw new Error('finish failed during teardown')
      }
    }
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  it('executes the instrumented script and delivers line-level probe logs', async () => {
    const runtimeSource = await readFile(
      join(directory, '.dsh-debug/run-e2e/trace-runtime.js'),
      'utf8',
    )
    const instrumented = await readFile(file, 'utf8')
    expect(instrumented).toContain('globalThis.__dshTraceProbe')

    // Execute exactly like a classic page: trace runtime first, then the app.
    vm.runInThisContext(runtimeSource, { filename: 'trace-runtime.js' })
    vm.runInThisContext(instrumented, { filename: 'app.js' })

    const waited = await runtime.control('wait', { action: 'wait', timeoutMs: 8_000 })
    if (waited.kind !== 'ok') throw new Error(`wait failed: ${waited.message}`)

    const read = await runtime.control('read', { action: 'read' })
    if (read.kind !== 'ok') throw new Error('read failed')
    const rawEvents = read.text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
    expect(rawEvents.length).toBeGreaterThan(0)
    expect(
      rawEvents.some(
        (event) => isRecord(event) && event.kind === 'probe' && event.runId === 'run-e2e',
      ),
    ).toBe(true)
    expect(
      rawEvents.some(
        (event) =>
          isRecord(event) &&
          event.kind === 'probe' &&
          typeof event.line === 'number' &&
          event.line >= 1,
      ),
    ).toBe(true)
  })

  it('restores the original source and removes the run directory on finish', async () => {
    const finished = await runtime.finish('diagnosed')
    if (finished.kind !== 'ok') throw new Error('finish failed')
    expect(finished.restored).toContain(file)
    await expect(readFile(file, 'utf8')).resolves.toBe(SCRIPT)
    await expect(
      readFile(join(directory, '.dsh-debug/run-e2e/trace-runtime.js'), 'utf8'),
    ).rejects.toThrow()
  })
})
