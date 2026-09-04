import { describe, expect, it } from 'vitest'
import {
  addRuntimeImport,
  instrumentJavaScript,
  parseJavaScript,
  removeInstrumentation,
  PROBE_HELPER,
  RUNTIME_IMPORT_MARKER,
} from '../../../src/instrumentation/js.ts'

const SOURCE = [
  "import { helper } from './helper'",
  '',
  'export function checkout(amount: number): number {',
  '  const fee = amount * 0.1',
  '  if (fee > 10) {',
  '    return fee + 2',
  '  }',
  '  return fee',
  '}',
  '',
].join('\n')

describe('javascript instrumentation', () => {
  it('parses TypeScript sources', () => {
    expect(parseJavaScript('const x: number = 1\n', 'a.ts').program.type).toBe('Program')
  })

  it('parses JSX sources', () => {
    expect(parseJavaScript('const el = <div a={1} />\n', 'a.tsx').program.type).toBe('Program')
  })

  it('splices probes into the located line range only', () => {
    const result = instrumentJavaScript(SOURCE, {
      runId: 'run-1',
      projectPath: 'src/checkout.ts',
      startLine: 4,
      endLine: 8,
    })
    expect(result.probes).toBe(4)
    expect(result.skipped).toBe(0)
    expect(result.code).toContain(PROBE_HELPER)
    expect(() => parseJavaScript(result.code, 'src/checkout.ts')).not.toThrow()
  })

  it('skips brace-less if and loop bodies', () => {
    const oneLine = 'let x = 0\nif (x) x++\nelse x += 2\nx += 1\n'
    const result = instrumentJavaScript(oneLine, {
      runId: 'run-2',
      projectPath: 'a.js',
      startLine: 1,
      endLine: 5,
    })
    expect(result.code).toContain('__dshTraceProbe')
    expect(() => parseJavaScript(result.code, 'a.js')).not.toThrow()

    const loops = 'let i = 0; while (i < 3) i++; for (;;) break; if (i) i--;\n'
    const loopResult = instrumentJavaScript(loops, {
      runId: 'run-loops',
      projectPath: 'loops.js',
      startLine: 1,
      endLine: 1,
    })
    expect(loopResult.code).toContain('__dshTraceProbe')
    expect(() => parseJavaScript(loopResult.code, 'loops.js')).not.toThrow()
  })

  it('instruments multiple statements on one line', () => {
    const result = instrumentJavaScript('const a = 1; const b = 2\n', {
      runId: 'run-same-line',
      projectPath: 'same.js',
      startLine: 1,
      endLine: 1,
    })
    expect(result.probes).toBe(2)
    expect(() => parseJavaScript(result.code, 'same.js')).not.toThrow()
  })

  it('caps probes and reports skipped sites', () => {
    const wide = Array.from({ length: 10 }, (_, index) => `const v${index} = ${index}`).join('\n')
    const result = instrumentJavaScript(`${wide}\n`, {
      runId: 'run-3',
      projectPath: 'wide.js',
      startLine: 1,
      endLine: 10,
      maxProbes: 3,
    })
    expect(result.probes).toBe(3)
    expect(result.skipped).toBe(7)
  })

  it('throws a readable error for invalid sources', () => {
    expect(() =>
      instrumentJavaScript('function {', {
        runId: 'r',
        projectPath: 'bad.js',
        startLine: 1,
        endLine: 2,
      }),
    ).toThrow(/cannot parse bad\.js/)
  })

  it('adds and removes runtime imports', () => {
    const moduleCode = 'export const x = 1\n'
    const withImport = addRuntimeImport(moduleCode, './.dsh-debug/runtime.js', 'run-9')
    expect(withImport.changed).toBe(true)
    expect(withImport.code).toContain(`${RUNTIME_IMPORT_MARKER}:run-9`)
    const cleaned = removeInstrumentation(withImport.code, 'run-9')
    expect(cleaned.code).toBe(moduleCode)
    expect(cleaned.removed).toBe(1)

    const classic = 'var x = 1\n'
    expect(addRuntimeImport(classic, './runtime.js', 'run-9').changed).toBe(false)
  })

  it('removes only probes owned by the run id', () => {
    const result = instrumentJavaScript(SOURCE, {
      runId: 'run-a',
      projectPath: 'src/checkout.ts',
      startLine: 4,
      endLine: 8,
    })
    const otherRun = removeInstrumentation(result.code, 'run-b')
    expect(otherRun.removed).toBe(0)
    console.error('INSTRUMENTED>>>\n' + result.code + '\n<<<')
    const ownRun = removeInstrumentation(result.code, 'run-a')
    expect(ownRun.removed).toBe(4)
    expect(() => parseJavaScript(ownRun.code, 'src/checkout.ts')).not.toThrow()
  })
})
