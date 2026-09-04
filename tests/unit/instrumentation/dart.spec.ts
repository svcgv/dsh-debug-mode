import { describe, expect, it } from 'vitest'
import {
  addDartRuntimeImport,
  createDartRuntimeSource,
  instrumentDart,
  isSafeStatementLine,
  isSkippableDartLine,
  looksLikeFunctionOpen,
  removeDartInstrumentation,
} from '../../../src/instrumentation/dart.ts'

const SOURCE = [
  "import 'package:flutter/material.dart';",
  '',
  'int calculate(int amount) {',
  '  final fee = amount * 2;',
  '  if (fee > 10) {',
  '    return fee;',
  '  }',
  '  return 0;',
  '}',
  '',
].join('\n')

describe('dart instrumentation', () => {
  it('detects skippable and safe lines', () => {
    expect(isSkippableDartLine('   ')).toBe(true)
    expect(isSkippableDartLine('// comment')).toBe(true)
    expect(isSkippableDartLine('/* block')).toBe(true)
    expect(isSkippableDartLine('final x = 1;')).toBe(false)
    expect(isSafeStatementLine('return fee;')).toBe(true)
    expect(isSafeStatementLine('throw err;')).toBe(true)
    expect(isSafeStatementLine('final fee = 1;')).toBe(false)
    expect(isSafeStatementLine('return fee')).toBe(false)
    expect(isSafeStatementLine('// return fee;')).toBe(false)
    expect(looksLikeFunctionOpen('int calculate(int amount) {')).toBe(true)
    expect(looksLikeFunctionOpen('if (fee > 10) {')).toBe(false)
    expect(looksLikeFunctionOpen('class Foo {')).toBe(false)
  })

  it('instruments function opens and single-line returns inside the range', () => {
    const result = instrumentDart(SOURCE, {
      runId: 'dart-1',
      projectPath: 'lib/calc.dart',
      startLine: 3,
      endLine: 8,
    })
    expect(result.probes).toBeGreaterThanOrEqual(2)
    expect(result.code).toContain('dsh.trace(')
    expect(result.code).toContain('lib/calc.dart')
    const cleaned = removeDartInstrumentation(result.code, 'dart-1')
    expect(cleaned.removed).toBeGreaterThan(0)
    expect(cleaned.code).not.toContain('dsh.trace(')
  })

  it('covers control headers, throw paths, and probe caps', () => {
    const tricky = [
      'void main() {',
      '  for (int i = 0; i < 3; i++) {',
      '    if (i == 2) {',
      '      throw Exception("boom");',
      '    }',
      '    while (i > 0) {',
      '      break;',
      '    }',
      '  }',
      '  switch (0) {',
      '    default:',
      '      try {',
      '        return;',
      '      } catch (_) {}',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = instrumentDart(tricky, {
      runId: 'tricky',
      projectPath: 'lib/t.dart',
      startLine: 1,
      endLine: 30,
      maxProbes: 2,
    })
    expect(result.probes).toBe(2)
    expect(result.code).toContain('dsh.trace(')
    const cleaned = removeDartInstrumentation(result.code, 'tricky')
    expect(cleaned.removed).toBeGreaterThan(0)
    expect(looksLikeFunctionOpen('')).toBe(false)
  })

  it('prepends a marked runtime import and generates a parseable runtime library', () => {
    const withImport = addDartRuntimeImport(SOURCE, 'dsh_trace.dart', 'dart-9')
    expect(withImport.startsWith("import 'dsh_trace.dart'; // dsh_trace_import:dart-9")).toBe(true)
    const runtime = createDartRuntimeSource('dart-9', 'http://127.0.0.1:9/', 'tok')
    expect(runtime).toContain('Future<void> trace')
    expect(runtime).toContain('dart-9')
  })
})
