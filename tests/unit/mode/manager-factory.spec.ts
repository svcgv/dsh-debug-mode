import { describe, expect, it } from 'vitest'
import type { DebugRuntime } from '../../../src/run/manager.ts'
import { registerDebugRuntime } from '../../../src/run/registry.ts'
import { createDebugRunManager } from '../../../src/mode/host.ts'

function stubFrontend(): DebugRuntime {
  return {
    kind: 'frontend',
    start: () =>
      Promise.resolve({
        kind: 'ok',
        kindOfRun: 'frontend',
        status: 'waiting-for-reproduction',
        notice: 'waiting',
      }),
    control: () =>
      Promise.resolve({ kind: 'ok', status: 'waiting-for-reproduction', text: 'no events' }),
    finish: () =>
      Promise.resolve({
        kind: 'ok',
        status: 'finished',
        restored: [],
        couldNotRestore: [],
        summary: 'cleaned',
      }),
  }
}

describe('host run manager factory', () => {
  it('starts frontend runs through the registered factory', async () => {
    registerDebugRuntime('frontend', () => stubFrontend())
    const manager = createDebugRunManager()
    const result = await manager.start('s1', {
      targets: [{ path: 'a.ts', startLine: 1, endLine: 2 }],
      runtime: 'frontend',
    })
    expect(result).toMatchObject({ kind: 'ok', kindOfRun: 'frontend' })
  })

  it('fails loudly when no backend factory is registered', async () => {
    const manager = createDebugRunManager()
    const result = await manager.start('s1', {
      targets: [{ path: 'a.py', startLine: 1, endLine: 2 }],
      runtime: 'backend',
    })
    expect(result).toMatchObject({ kind: 'error', code: 'RUNTIME_UNAVAILABLE' })
  })
})
