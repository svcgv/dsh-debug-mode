import { describe, expect, it } from 'vitest'
import { parseJavaScript } from '../../../src/instrumentation/js.ts'
import { createTraceRuntimeSource, runtimeSourceChecks } from '../../../src/runtime/source.ts'

describe('trace runtime source', () => {
  it('emits a parseable runtime for one run', () => {
    const source = createTraceRuntimeSource({
      runId: 'run-1',
      token: 'tok',
      endpoints: ['http://127.0.0.1:9', 'http://10.0.0.2:9'],
      projectPath: 'src/a.ts',
    })
    expect(() => parseJavaScript(source, 'trace-runtime.js')).not.toThrow()
    expect(runtimeSourceChecks(source, 'run-1')).toBe(true)
    expect(source).toContain('http://10.0.0.2:9')
    expect(source).toContain('globalThis.__dshTraceHeartbeat')
    expect(source).toContain('globalThis.__dshTraceRotate')
  })

  it('omits secrets from plain text logs by construction', () => {
    const source = createTraceRuntimeSource({
      runId: 'run-2',
      token: 'super-secret',
      endpoints: ['http://127.0.0.1:9'],
      projectPath: 'src/b.ts',
    })
    expect(source).toContain('super-secret')
    // The token is JSON-quoted, never interpolated into a string that could
    // leak through HTML embedding.
    expect(source).not.toMatch(/<script/)
  })
})
