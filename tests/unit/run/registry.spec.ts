import { describe, expect, it } from 'vitest'
import type { DebugRuntime } from '../../../src/run/manager.ts'
import { registerDebugRuntime, resolveDebugRuntime } from '../../../src/run/registry.ts'

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

  it('registers, overwrites, and resolves adapters', () => {
    const first = stubRuntime('frontend')
    registerDebugRuntime('frontend', first)
    expect(resolveDebugRuntime('frontend')).toBe(first)

    const replacement = stubRuntime('frontend')
    registerDebugRuntime('frontend', replacement)
    expect(resolveDebugRuntime('frontend')).toBe(replacement)

    const backend = stubRuntime('backend')
    registerDebugRuntime('backend', backend)
    expect(resolveDebugRuntime('backend')).toBe(backend)
    expect(resolveDebugRuntime('frontend')).toBe(replacement)
  })
})
