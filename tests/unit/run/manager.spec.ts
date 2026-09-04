import { describe, expect, it } from 'vitest'
import {
  DebugRunManager,
  validateStartRequest,
  type DebugRuntime,
} from '../../../src/run/manager.ts'
import type {
  DebugControlResult,
  DebugFinishResult,
  DebugRunResult,
  DebugStartRequest,
} from '../../../src/run/types.ts'

function asControl(result: DebugRunResult): DebugControlResult | undefined {
  return result.kind === 'ok' && 'text' in result ? result : undefined
}

function asFinish(result: DebugRunResult): DebugFinishResult | undefined {
  return result.kind === 'ok' && 'restored' in result ? result : undefined
}

function fakeRuntime(overrides: Partial<DebugRuntime> = {}): DebugRuntime & { calls: string[] } {
  const calls: string[] = []
  return {
    kind: 'frontend',
    start: () => {
      calls.push('start')
      return Promise.resolve({
        kind: 'ok',
        kindOfRun: 'frontend',
        status: 'waiting-for-reproduction',
        notice: 'Instrumented and waiting.',
      })
    },
    control: () => {
      calls.push('control')
      return Promise.resolve({
        kind: 'ok',
        status: 'waiting-for-reproduction',
        text: 'no new events',
      })
    },
    finish: () => {
      calls.push('finish')
      return Promise.resolve({
        kind: 'ok',
        status: 'finished',
        restored: ['a.ts'],
        couldNotRestore: [],
        summary: 'cleaned',
      })
    },
    ...overrides,
    calls,
  }
}

const startRequest = (runtime: DebugStartRequest['runtime'] = 'frontend'): DebugStartRequest => ({
  targets: [{ path: 'src/a.ts', startLine: 10, endLine: 12 }],
  runtime,
})

describe('DebugRunManager', () => {
  it('starts, controls, and finishes a run', async () => {
    const runtime = fakeRuntime()
    const manager = new DebugRunManager(() => runtime)
    const started = await manager.start('s1', startRequest())
    expect(started).toMatchObject({
      kind: 'ok',
      kindOfRun: 'frontend',
      status: 'waiting-for-reproduction',
    })
    if (started.kind !== 'ok') return
    expect(started.runId).toMatch(/^dsh-debug-run-s1-/)
    const controlled = await manager.control('s1', { action: 'read' })
    const controlResult = asControl(controlled)
    expect(controlResult?.text).toBe('no new events')
    const finished = await manager.finish('s1', 'diagnosed')
    const finishResult = asFinish(finished)
    expect(finishResult?.status).toBe('finished')
    expect(finishResult?.restored).toEqual(['a.ts'])
    expect(runtime.calls).toEqual(['start', 'control', 'finish'])
    expect(manager.hasActiveRun('s1')).toBe(false)
  })

  it('rejects a second concurrent run', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    await manager.start('s1', startRequest())
    const second = await manager.start('s1', startRequest())
    expect(second).toMatchObject({ kind: 'error', code: 'RUN_ALREADY_ACTIVE' })
  })

  it('fails loudly when the runtime adapter is missing', async () => {
    const manager = new DebugRunManager(() => undefined)
    const result = await manager.start('s1', startRequest('backend'))
    expect(result).toMatchObject({ kind: 'error', code: 'RUNTIME_UNAVAILABLE' })
  })

  it('validates target ranges before starting', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    expect(await manager.start('s1', { targets: [], runtime: 'frontend' })).toMatchObject({
      kind: 'error',
      code: 'INVALID_TARGETS',
    })
    expect(
      await manager.start('s2', {
        targets: [{ path: '', startLine: 1, endLine: 1 }],
        runtime: 'frontend',
      }),
    ).toMatchObject({
      kind: 'error',
      code: 'INVALID_TARGETS',
    })
    expect(
      await manager.start('s3', {
        targets: [{ path: 'x', startLine: 5, endLine: 2 }],
        runtime: 'frontend',
      }),
    ).toMatchObject({ kind: 'error', code: 'INVALID_TARGETS' })
    expect(
      await manager.start('s4', {
        targets: [{ path: 'x', startLine: 0, endLine: 1 }],
        runtime: 'frontend',
      }),
    ).toMatchObject({ kind: 'error', code: 'INVALID_TARGETS' })
    expect(
      await manager.start('s5', {
        targets: [
          { path: 'a', startLine: 1, endLine: 1 },
          { path: 'b', startLine: 1, endLine: 1 },
          { path: 'c', startLine: 1, endLine: 1 },
          { path: 'd', startLine: 1, endLine: 1 },
          { path: 'e', startLine: 1, endLine: 1 },
          { path: 'f', startLine: 1, endLine: 1 },
        ],
        runtime: 'frontend',
      }),
    ).toMatchObject({ kind: 'error', code: 'INVALID_TARGETS' })
    const bogus = validateStartRequest({
      targets: [{ path: 'x', startLine: 1, endLine: 1 }],
      runtime: 'bogus',
    })
    expect(bogus).toMatchObject({ kind: 'error', code: 'INVALID_TARGETS' })
  })

  it('clears the session when runtime start fails', async () => {
    const runtime = fakeRuntime({
      start: () =>
        Promise.resolve({
          kind: 'error' as const,
          code: 'INVALID_TARGETS' as const,
          message: 'no',
          retryable: false,
        }),
    })
    const manager = new DebugRunManager(() => runtime)
    const result = await manager.start('s1', startRequest())
    expect(result).toMatchObject({ kind: 'error', code: 'INVALID_TARGETS' })
    expect(manager.hasActiveRun('s1')).toBe(false)
  })

  it('rejects control and finish without an active run', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    expect(await manager.control('s1', { action: 'status' })).toMatchObject({
      kind: 'error',
      code: 'NO_ACTIVE_RUN',
    })
    expect(await manager.finish('s1', 'cancelled')).toMatchObject({
      kind: 'error',
      code: 'NO_ACTIVE_RUN',
    })
  })

  it('refuses control on finished runs', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    await manager.start('s1', startRequest())
    await manager.finish('s1', 'cancelled')
    expect(await manager.control('s1', { action: 'read' })).toMatchObject({
      kind: 'error',
      code: 'NO_ACTIVE_RUN',
    })
  })

  it('refuses control after a run reports a terminal status', async () => {
    const runtime = fakeRuntime({
      control: () => Promise.resolve({ kind: 'ok', status: 'failed', text: 'crashed' }),
    })
    const manager = new DebugRunManager(() => runtime)
    await manager.start('s1', startRequest())
    await manager.control('s1', { action: 'read' })
    expect(await manager.control('s1', { action: 'read' })).toMatchObject({
      kind: 'error',
      code: 'NOT_READY',
    })
    const finished = await manager.finish('s1', 'cancelled')
    expect(finished.kind).toBe('ok')
  })

  it('propagates control cursors', async () => {
    const runtime = fakeRuntime({
      control: () =>
        Promise.resolve({ kind: 'ok', status: 'paused', cursor: 'c-7', text: 'paused' }),
    })
    const manager = new DebugRunManager(() => runtime)
    await manager.start('s1', startRequest())
    const result = await manager.control('s1', { action: 'stack' })
    const controlResult = asControl(result)
    expect(controlResult?.cursor).toBe('c-7')
    expect(controlResult?.status).toBe('paused')
  })

  it('surfaces runtime control and finish failures', async () => {
    const failingControl = fakeRuntime({
      control: () =>
        Promise.resolve({
          kind: 'error',
          code: 'UNSUPPORTED_ACTION',
          message: 'no',
          retryable: false,
        }),
    })
    const controlManager = new DebugRunManager(() => failingControl)
    await controlManager.start('s1', startRequest())
    expect(await controlManager.control('s1', { action: 'evaluate' })).toMatchObject({
      kind: 'error',
      code: 'UNSUPPORTED_ACTION',
    })

    const failingFinish = fakeRuntime({
      finish: () =>
        Promise.resolve({ kind: 'error', code: 'NOT_READY', message: 'no', retryable: false }),
    })
    const finishManager = new DebugRunManager(() => failingFinish)
    await finishManager.start('s2', startRequest())
    expect(await finishManager.finish('s2', 'cancelled')).toMatchObject({
      kind: 'error',
      code: 'NOT_READY',
    })
    expect(finishManager.hasActiveRun('s2')).toBe(false)
  })

  it('keeps slot semantics for status and abandon', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    expect(manager.status('s1')).toEqual({})
    await manager.start('s1', startRequest())
    expect(manager.status('s1').runId).toBeDefined()
    expect(manager.abandon('s1')).toBe(true)
    expect(manager.abandon('s1')).toBe(false)
    expect(manager.hasActiveRun('s1')).toBe(false)
  })

  it('starts an auto-classified frontend run', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    const result = await manager.start('s1', startRequest('auto'))
    expect(result).toMatchObject({ kind: 'ok', kindOfRun: 'frontend' })
  })

  it('auto classifies empty targets as invalid and otherwise frontend', () => {
    const manager = new DebugRunManager(() => undefined)
    expect(manager.classify({ targets: [], runtime: 'auto' })).toBeUndefined()
    expect(manager.classify(startRequest('auto'))).toBe('frontend')
    expect(manager.classify(startRequest('backend'))).toBe('backend')
  })
})
