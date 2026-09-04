import { describe, expect, it } from 'vitest'
import type { DebugRuntime } from '../../../src/run/manager.ts'
import { registerDebugRuntime, resolveDebugRuntime } from '../../../src/run/registry.ts'
import type { DebugRuntimeFactory } from '../../../src/run/registry.ts'

function stubRuntime(kind: DebugRuntime['kind']): DebugRuntime {
  return {
    kind,
    start: () =>
      Promise.resolve({
        kind: 'error',
        code: 'INVALID_TARGETS',
        message: 'not wired',
        retryable: false,
      }),
    control: () =>
      Promise.resolve({
        kind: 'error',
        code: 'UNSUPPORTED_ACTION',
        message: 'not wired',
        retryable: false,
      }),
    finish: () =>
      Promise.resolve({ kind: 'error', code: 'NOT_READY', message: 'not wired', retryable: false }),
  }
}

describe('runtime adapter registry', () => {
  it('resolves nothing before registration', () => {
    expect(resolveDebugRuntime('frontend')).toBeUndefined()
    expect(resolveDebugRuntime('backend')).toBeUndefined()
  })

  it('registers, overwrites, and resolves factories', () => {
    const first = stubRuntime('frontend')
    registerDebugRuntime('frontend', () => first)
    expect(resolveDebugRuntime('frontend')?.('run-1')).toBe(first)

    const replacement = stubRuntime('frontend')
    registerDebugRuntime('frontend', () => replacement)
    expect(resolveDebugRuntime('frontend')?.('run-2')).toBe(replacement)

    const backend = stubRuntime('backend')
    registerDebugRuntime('backend', () => backend)
    expect(resolveDebugRuntime('backend')?.('run-3')).toBe(backend)
  })

  it('mints an independent instance per run id', () => {
    let created = 0
    const factory: DebugRuntimeFactory = () => {
      created += 1
      return stubRuntime('frontend')
    }
    registerDebugRuntime('frontend', factory)
    const first = resolveDebugRuntime('frontend')
    const second = resolveDebugRuntime('frontend')
    expect(first).toBe(second)
    expect(first?.('a')).not.toBe(first?.('b'))
    expect(created).toBe(2)
  })
})
