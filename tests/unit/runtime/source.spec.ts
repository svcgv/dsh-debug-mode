import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parseJavaScript } from '../../../src/instrumentation/js.ts'
import { createTraceRuntimeSource, runtimeSourceChecks } from '../../../src/runtime/source.ts'

function isProbe(value: unknown): value is (meta: Record<string, unknown>) => void {
  return typeof value === 'function'
}

function errorCode(context: Record<string, unknown>): unknown {
  const error = context['__dshTraceLastError']
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

describe('trace runtime source', () => {
  it('emits a parseable local-log runtime without a collector endpoint', () => {
    const source = createTraceRuntimeSource({
      transport: 'local-log',
      runId: 'run-local',
      projectPath: 'src/a.ts',
    })
    expect(() => parseJavaScript(source, 'trace-runtime.js')).not.toThrow()
    expect(runtimeSourceChecks(source, 'run-local')).toBe(true)
    expect(source).toContain('[dsh-debug:run-local]')
    expect(source).toContain('target.log')
    expect(source).not.toContain('/ingest')
    expect(source).not.toContain('fetch(')
  })

  it('prints heartbeat and line-level probe evidence to the local log', () => {
    const logs: string[] = []
    const context: Record<string, unknown> = {
      console: {
        log: (line: unknown) => logs.push(String(line)),
      },
    }
    const source = createTraceRuntimeSource({
      transport: 'local-log',
      runId: 'run-output',
      projectPath: 'src/output.ts',
    })
    vm.runInNewContext(source, context)
    const probe = context['__dshTraceProbe']
    if (!isProbe(probe)) throw new Error('trace probe was not installed')
    probe({ p: 'src/output.ts', l: 17, k: 's' })

    expect(logs).toHaveLength(2)
    expect(logs[0]).toContain('[dsh-debug:run-output]')
    expect(logs[0]).toContain('"kind":"heartbeat"')
    expect(logs[1]).toContain('"kind":"probe"')
    expect(logs[1]).toContain('"file":"src/output.ts"')
    expect(logs[1]).toContain('"line":17')
  })

  it('redacts, bounds, and safely serializes local log evidence', () => {
    const logs: string[] = []
    const context: Record<string, unknown> = {
      console: {
        log: (line: unknown) => logs.push(String(line)),
      },
    }
    const source = createTraceRuntimeSource({
      transport: 'local-log',
      runId: 'run-safe',
      projectPath: 'src/safe.ts',
    })
    vm.runInNewContext(source, context)
    const probe = context['__dshTraceProbe']
    if (!isProbe(probe)) throw new Error('trace probe was not installed')
    const sensitiveMeta: Record<string, unknown> = {
      locals: { password: 'must-not-leak', visible: 'ok' },
    }
    let getterCalls = 0
    Object.defineProperty(sensitiveMeta, 'computed', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 'must-not-run'
      },
    })
    sensitiveMeta.self = sensitiveMeta
    probe(sensitiveMeta)

    const redactedLine = logs.at(-1) ?? ''
    expect(redactedLine).toContain('"password":"[REDACTED]"')
    expect(redactedLine).toContain('"redacted":["password"]')
    expect(redactedLine).toContain('"self":"[Circular]"')
    expect(redactedLine).toContain('"computed":"[Getter]"')
    expect(redactedLine).not.toContain('must-not-leak')
    expect(redactedLine).not.toContain('must-not-run')
    expect(getterCalls).toBe(0)

    const largeMeta: Record<string, unknown> = {}
    for (let index = 0; index < 40; index += 1) {
      largeMeta[`field${index}`] = 'x'.repeat(1_000)
    }
    probe(largeMeta)

    const line = logs.at(-1) ?? ''
    expect(line).toContain('"kind":"truncated"')
    expect(line.length).toBeLessThan(5_000)
  })

  it('caps the total number of local log records for one run', () => {
    const logs: string[] = []
    const context: Record<string, unknown> = {
      console: {
        log: (line: unknown) => logs.push(String(line)),
      },
    }
    const source = createTraceRuntimeSource({
      transport: 'local-log',
      runId: 'run-capped',
      projectPath: 'src/capped.ts',
    })
    vm.runInNewContext(source, context)
    const probe = context['__dshTraceProbe']
    if (!isProbe(probe)) throw new Error('trace probe was not installed')
    for (let index = 0; index < 1_005; index += 1) probe({ index })

    expect(logs).toHaveLength(1_000)
    expect(errorCode(context)).toBe('LOCAL_LOG_EVENT_LIMIT')
  })

  it('records a stable error when local application logging is unavailable', () => {
    const unavailable: Record<string, unknown> = { console: undefined }
    const source = createTraceRuntimeSource({
      transport: 'local-log',
      runId: 'run-unavailable',
      projectPath: 'src/unavailable.ts',
    })
    expect(() => {
      void vm.runInNewContext(source, unavailable)
    }).not.toThrow()
    expect(errorCode(unavailable)).toBe('LOCAL_LOG_UNAVAILABLE')

    const throwing: Record<string, unknown> = {
      console: {
        log: () => {
          throw new Error('closed stream')
        },
      },
    }
    expect(() => {
      void vm.runInNewContext(source, throwing)
    }).not.toThrow()
    expect(errorCode(throwing)).toBe('LOCAL_LOG_WRITE_FAILED')
  })

  it('emits a parseable listener runtime with bounded endpoint delivery', () => {
    const source = createTraceRuntimeSource({
      transport: 'listener',
      runId: 'run-listener',
      token: 'tok',
      endpoints: ['http://127.0.0.1:9', 'http://10.0.0.2:9'],
      projectPath: 'src/b.ts',
    })
    expect(() => parseJavaScript(source, 'trace-runtime.js')).not.toThrow()
    expect(runtimeSourceChecks(source, 'run-listener')).toBe(true)
    expect(source).toContain('http://10.0.0.2:9')
    expect(source).toContain('globalThis.__dshTraceRotate')
    expect(source).toContain('/ingest')
  })

  it('keeps the listener token out of executable markup contexts', () => {
    const source = createTraceRuntimeSource({
      transport: 'listener',
      runId: 'run-secret',
      token: 'super-secret',
      endpoints: ['http://127.0.0.1:9'],
      projectPath: 'src/c.ts',
    })
    expect(source).toContain('super-secret')
    // The token is JSON-quoted, never interpolated into a string that could
    // leak through HTML embedding.
    expect(source).not.toMatch(/<script/)
  })
})
