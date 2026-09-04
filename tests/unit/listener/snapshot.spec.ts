import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, isSensitiveKey, snapshotLocals } from '../../../src/listener/snapshot.ts'
import type { SnapshotLimits } from '../../../src/listener/snapshot.ts'
import type { TraceJson } from '../../../src/listener/types.ts'

function recordOf(value: TraceJson | undefined): Record<string, TraceJson> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

describe('probe snapshot', () => {
  it('returns undefined locals for empty input', () => {
    expect(snapshotLocals(undefined)).toEqual({ locals: undefined, redacted: [], truncated: false })
    expect(snapshotLocals({})).toEqual({ locals: undefined, redacted: [], truncated: false })
  })

  it('flags sensitive keys and redacts their values', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('authorization')).toBe(true)
    expect(isSensitiveKey('password2')).toBe(true)
    expect(isSensitiveKey('cookie')).toBe(true)
    expect(isSensitiveKey('session_token')).toBe(true)
    expect(isSensitiveKey('count')).toBe(false)
    const result = snapshotLocals({ apiKey: 'abc', count: 3 })
    expect(result.redacted).toEqual(['apiKey'])
    expect(result.locals).toEqual({ apiKey: '[redacted]', count: 3 })
  })

  it('flattens nested objects and arrays with depth limits', () => {
    const limits: SnapshotLimits = { ...DEFAULT_LIMITS, maxDepth: 2, maxVars: 3 }
    const result = snapshotLocals({ a: { b: { c: { d: 1 } } } }, limits)
    expect(result.truncated).toBe(true)
    expect(result.locals).toEqual({ a: { b: '[depth-limit]' } })
  })

  it('truncates long strings, arrays, and non-finite numbers', () => {
    const limits: SnapshotLimits = { ...DEFAULT_LIMITS, maxStringLength: 4, maxVars: 4 }
    const result = snapshotLocals({ s: 'abcdef', nan: Number.NaN, inf: Infinity }, limits)
    expect(result.locals).toMatchObject({ s: 'abcd…', nan: null, inf: null })

    const arrayLimits: SnapshotLimits = { ...DEFAULT_LIMITS, maxVars: 2 }
    const arrayResult = snapshotLocals({ arr: [1, 2, 3] }, arrayLimits)
    expect(arrayResult.locals).toEqual({ arr: [1, 2, '[truncated]'] })
    expect(arrayResult.truncated).toBe(true)
  })

  it('cuts arrays mid-iteration when the byte budget is exhausted', () => {
    const limits: SnapshotLimits = { ...DEFAULT_LIMITS, maxVars: 100, maxBytes: 20 }
    const result = snapshotLocals({ arr: ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'] }, limits)
    expect(result.truncated).toBe(true)
    const locals = recordOf(result.locals)
    expect(Array.isArray(locals?.arr)).toBe(true)
    expect(locals?.arr).toContain('[budget-limit]')
  })

  it('keeps null and boolean scalars and marks unsupported values', () => {
    const result = snapshotLocals({ z: null, yes: true, sym: Symbol('x') })
    expect(result.locals).toMatchObject({ z: null, yes: true, sym: '[unsupported]' })
  })

  it('stops collecting object keys once the budget is exhausted', () => {
    const limits: SnapshotLimits = { ...DEFAULT_LIMITS, maxBytes: 6 }
    const result = snapshotLocals({ a: 'aaaa', b: 'bbbb', c: 'cccc' }, limits)
    expect(result.truncated).toBe(true)
    expect(recordOf(result.locals)).toBeDefined()
  })

  it('marks unsupported array items', () => {
    const result = snapshotLocals({ arr: [() => undefined, 1] })
    expect(result.locals).toEqual({ arr: ['[unsupported]', 1] })
  })

  it('marks objects that exceed the variable cap', () => {
    const limits: SnapshotLimits = { ...DEFAULT_LIMITS, maxVars: 2 }
    const result = snapshotLocals({ a: 1, b: 2, c: 3 }, limits)
    expect(result.truncated).toBe(true)
  })

  it('marks unsupported values and enforces byte budget', () => {
    const limits: SnapshotLimits = { ...DEFAULT_LIMITS, maxDepth: 1, maxVars: 2, maxBytes: 30 }
    const result = snapshotLocals({ fn: () => undefined, big: 'x'.repeat(200) }, limits)
    expect(result.truncated).toBe(true)
    expect(result.locals).toBeDefined()
  })
})
