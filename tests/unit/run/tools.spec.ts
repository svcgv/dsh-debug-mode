import { describe, expect, it } from 'vitest'
import type { CompatCommands, CompatHostContext } from '../../../src/compat/host-context.ts'
import { DebugRunManager, type DebugRuntime } from '../../../src/run/manager.ts'
import {
  debugToolDefinitions,
  parseControlArgs,
  parseFinishArgs,
  parseStartArgs,
  parseTargets,
  type DebugToolDefinition,
} from '../../../src/run/tools.ts'
import type { DebugUnitState } from '../../../src/mode/types.ts'

type RegisteredSection = Parameters<CompatHostContext['systemPrompt']['section']>[0]

function toolAt(tools: readonly DebugToolDefinition[], index: number): DebugToolDefinition {
  const tool = tools[index]
  if (tool === undefined) throw new Error(`missing tool ${index}`)
  return tool
}

function fakeRuntime(): DebugRuntime & { calls: string[] } {
  const calls: string[] = []
  return {
    kind: 'frontend',
    start: () => {
      calls.push('start')
      return Promise.resolve({
        kind: 'ok',
        kindOfRun: 'frontend',
        status: 'waiting-for-reproduction',
        notice: 'Instrumented src/a.ts and opened a trace listener. Reproduce the issue now.',
      })
    },
    control: () => {
      calls.push('control')
      return Promise.resolve({
        kind: 'ok',
        status: 'waiting-for-reproduction',
        text: 'No new trace events yet.',
      })
    },
    finish: () => {
      calls.push('finish')
      return Promise.resolve({
        kind: 'ok',
        status: 'finished',
        restored: ['src/a.ts'],
        couldNotRestore: ['ios/Info.plist'],
        summary: 'Removed probes and stopped the listener.',
      })
    },
    calls,
  }
}

function makeContext(active: boolean, missing = false): CompatHostContext {
  const state: DebugUnitState = missing
    ? { active: false, running: null }
    : { active, running: null }
  return {
    sessionProjections: {
      register: () => () => undefined,
      stateOf: () => (missing ? undefined : state),
    },
    systemPrompt: {
      section: (section: RegisteredSection) => {
        void section
        return () => undefined
      },
    },
    tools: { register: () => undefined },
    inject: (
      _services: readonly string[],
      callback: (ctx: { commands: CompatCommands }) => void,
    ) => {
      void callback
    },
  }
}

const execAgent = {
  agent: { session: { id: 's1' } },
  signal: new AbortController().signal,
}

describe('debug tools', () => {
  it('validates parser inputs through every failure branch', () => {
    expect(() => parseStartArgs(null)).toThrow(/must be an object/)
    expect(() => parseControlArgs(null)).toThrow(/must be an object/)
    expect(() => parseFinishArgs(null)).toThrow(/must be an object/)
    expect(() => parseStartArgs({ runtime: 'frontend' })).toThrow(/targets must be an array/)
    expect(() => parseTargets(null)).toThrow(/targets must be an array/)
    expect(() => parseTargets(['x'])).toThrow(/must be an object/)
    expect(() => parseTargets([{ path: 'a' }])).toThrow(/startLine/)
    expect(() => parseTargets([{ path: 'a', startLine: '1', endLine: 2 }])).toThrow(
      /startLine must be an integer/,
    )
    expect(() => parseTargets([{ path: 3, startLine: 1, endLine: 2 }])).toThrow(
      /path must be a string/,
    )
    expect(parseTargets([])).toEqual([])
    expect(() =>
      parseStartArgs({ targets: [{ path: 'a', startLine: 1, endLine: 1 }], runtime: 'x' }),
    ).toThrow(/runtime must be/)
    expect(() =>
      parseStartArgs({
        targets: [{ path: 'a', startLine: 1, endLine: 1 }],
        runtime: 'frontend',
        launchId: 5,
      }),
    ).toThrow(/launchId must be a string/)
    expect(
      parseStartArgs({
        targets: [{ path: 'a', startLine: 1, endLine: 1 }],
        runtime: 'frontend',
        launchId: 'x',
      }),
    ).toMatchObject({
      runtime: 'frontend',
      launchId: 'x',
    })
    expect(() => parseControlArgs({ action: 5 })).toThrow(/action must be a string/)
    expect(() => parseControlArgs({ action: 'read', cursor: 5 })).toThrow(/cursor must be a string/)
    expect(() => parseControlArgs({ action: 'read', timeoutMs: '1' })).toThrow(
      /timeoutMs must be an integer/,
    )
    expect(() => parseControlArgs({ action: 'read', frameId: 5 })).toThrow(
      /frameId must be a string/,
    )
    expect(() => parseControlArgs({ action: 'read', expression: 5 })).toThrow(
      /expression must be a string/,
    )
    expect(
      parseControlArgs({
        action: 'evaluate',
        cursor: 'c',
        timeoutMs: 100,
        frameId: 'f',
        expression: 'x',
      }),
    ).toMatchObject({
      action: 'evaluate',
      cursor: 'c',
      timeoutMs: 100,
      frameId: 'f',
      expression: 'x',
    })
    expect(() => parseFinishArgs({ outcome: 5 })).toThrow(/outcome must be a string/)
  })

  it('renders canonical output as plain text', () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    const tools = debugToolDefinitions(makeContext(true), manager)
    expect(toolAt(tools, 0).output.render({}, 'hello')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('starts a run and returns the adapter notice', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    const tools = debugToolDefinitions(makeContext(true), manager)
    const startTool = toolAt(tools, 0)
    const text = await startTool.execute(
      { targets: [{ path: 'src/a.ts', startLine: 10, endLine: 12 }], runtime: 'frontend' },
      execAgent,
    )
    expect(text).toContain('Instrumented src/a.ts')
  })

  it('reads control results', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    const tools = debugToolDefinitions(makeContext(true), manager)
    await toolAt(tools, 0).execute(
      { targets: [{ path: 'src/a.ts', startLine: 10, endLine: 12 }], runtime: 'auto' },
      execAgent,
    )
    const text = await toolAt(tools, 1).execute({ action: 'read' }, execAgent)
    expect(text).toBe('No new trace events yet.')
  })

  it('finishes and reports restoration results', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    const tools = debugToolDefinitions(makeContext(true), manager)
    await toolAt(tools, 0).execute(
      { targets: [{ path: 'src/a.ts', startLine: 10, endLine: 12 }], runtime: 'frontend' },
      execAgent,
    )
    const text = await toolAt(tools, 2).execute({ outcome: 'diagnosed' }, execAgent)
    expect(text).toContain('Removed probes')
    expect(text).toContain('ios/Info.plist')
  })

  it('surfaces control and finish run failures as bracketed text', async () => {
    const noRuntime = new DebugRunManager(() => undefined)
    const unavailableTools = debugToolDefinitions(makeContext(true), noRuntime)
    const controlText = await toolAt(unavailableTools, 1).execute({ action: 'read' }, execAgent)
    expect(controlText).toMatch(/^\[NO_ACTIVE_RUN\]/)
    const finishText = await toolAt(unavailableTools, 2).execute(
      { outcome: 'cancelled' },
      execAgent,
    )
    expect(finishText).toMatch(/^\[NO_ACTIVE_RUN\]/)
  })

  it('finishes cleanly when nothing needs manual restoration', async () => {
    const runtime = fakeRuntime()
    runtime.finish = () =>
      Promise.resolve({
        kind: 'ok',
        status: 'finished',
        restored: ['src/a.ts'],
        couldNotRestore: [],
        summary: 'Cleaned up.',
      })
    const manager = new DebugRunManager(() => runtime)
    const tools = debugToolDefinitions(makeContext(true), manager)
    await toolAt(tools, 0).execute(
      { targets: [{ path: 'src/a.ts', startLine: 10, endLine: 12 }], runtime: 'frontend' },
      execAgent,
    )
    const text = await toolAt(tools, 2).execute({ outcome: 'verified' }, execAgent)
    expect(text).toBe('Cleaned up.')
  })

  it('gates every tool on committed debug mode', async () => {
    const inactiveManager = new DebugRunManager(() => fakeRuntime())
    const inactiveTools = debugToolDefinitions(makeContext(false), inactiveManager)
    await expect(
      toolAt(inactiveTools, 0).execute(
        { targets: [{ path: 'a', startLine: 1, endLine: 1 }], runtime: 'frontend' },
        execAgent,
      ),
    ).rejects.toThrow(/not active/)
    const missingManager = new DebugRunManager(() => fakeRuntime())
    const missingTools = debugToolDefinitions(makeContext(true, true), missingManager)
    await expect(toolAt(missingTools, 1).execute({ action: 'status' }, execAgent)).rejects.toThrow(
      /not active/,
    )
  })

  it('requires a calling agent', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    const tools = debugToolDefinitions(makeContext(true), manager)
    await expect(
      toolAt(tools, 0).execute(
        { targets: [{ path: 'a', startLine: 1, endLine: 1 }], runtime: 'frontend' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/calling agent/)
  })

  it('rejects malformed arguments', async () => {
    const manager = new DebugRunManager(() => fakeRuntime())
    const tools = debugToolDefinitions(makeContext(true), manager)
    await expect(toolAt(tools, 0).execute({ runtime: 'frontend' }, execAgent)).rejects.toThrow(
      /targets/,
    )
    await expect(
      toolAt(tools, 0).execute(
        { targets: [{ path: 'a', startLine: 0, endLine: 1 }], runtime: 'frontend' },
        execAgent,
      ),
    ).resolves.toMatch(/invalid line range/)
    await expect(
      toolAt(tools, 0).execute(
        { targets: [{ path: 'a', startLine: 1, endLine: 1 }], runtime: 'x' },
        execAgent,
      ),
    ).rejects.toThrow(/runtime/)
    await expect(toolAt(tools, 1).execute({}, execAgent)).rejects.toThrow(/action/)
    await expect(toolAt(tools, 1).execute({ action: 'jump' }, execAgent)).rejects.toThrow(/one of/)
    await expect(
      toolAt(tools, 1).execute({ action: 'read', timeoutMs: 1.5 }, execAgent),
    ).rejects.toThrow(/integer/)
    await expect(toolAt(tools, 2).execute({}, execAgent)).rejects.toThrow(/outcome/)
    await expect(toolAt(tools, 2).execute({ outcome: 'maybe' }, execAgent)).rejects.toThrow(
      /diagnosed/,
    )
  })

  it('surfaces structured run failures as bracketed text', async () => {
    const manager = new DebugRunManager(() => undefined)
    const tools = debugToolDefinitions(makeContext(true), manager)
    const text = await toolAt(tools, 0).execute(
      { targets: [{ path: 'a', startLine: 1, endLine: 1 }], runtime: 'backend' },
      execAgent,
    )
    expect(text).toBe(
      '[RUNTIME_UNAVAILABLE] The backend runtime adapter is not available in this build; install the matching dsh-debug-mode adapter bundle.',
    )
  })
})
