import { describe, expect, it } from 'vitest'
import type {
  CompatAgent,
  CompatCommandInvocation,
  CompatCommands,
  CompatHostContext,
} from '../../../src/compat/host-context.ts'
import { apply, handleDebugCommand, name } from '../../../src/mode/host.ts'
import { DEBUG_POLICY_ORDER } from '../../../src/mode/policy.ts'
import type { DebugUnitState } from '../../../src/mode/types.ts'

type RegisteredCommand = Parameters<CompatCommands['register']>[0]
type RegisteredSection = Parameters<CompatHostContext['systemPrompt']['section']>[0]

function makeAgent(options: { planMode?: unknown } = {}): CompatAgent {
  const services = new Map<string, unknown>()
  if (options.planMode !== undefined) services.set('planMode', options.planMode)
  return {
    session: { id: 's1' },
    ctx: { get: (serviceName: string) => services.get(serviceName) },
    steer: () => undefined,
  }
}

function makeContext(options: { initial?: DebugUnitState; noState?: boolean } = {}): {
  ctx: CompatHostContext
  registerCalls: { count: number }
  sections: RegisteredSection[]
  commands: RegisteredCommand[]
  state: DebugUnitState
} {
  const state: DebugUnitState = options.initial ?? { active: false, running: null }
  const registerCalls = { count: 0 }
  const sections: RegisteredSection[] = []
  const commands: RegisteredCommand[] = []
  const ctx: CompatHostContext = {
    tools: { register: () => undefined },
    sessionProjections: {
      register: () => {
        registerCalls.count += 1
        return () => undefined
      },
      stateOf: () => (options.noState === true ? undefined : state),
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => undefined
      },
    },
    inject: (_services, callback) => {
      const commandsService: CompatCommands = {
        register: (definition) => {
          commands.push(definition)
        },
      }
      callback({ commands: commandsService })
    },
  }
  return { ctx, registerCalls, sections, commands, state }
}

describe('debug mode host wiring', () => {
  it('exports the reserved plugin name', () => {
    expect(name).toBe('dsh-debug-mode')
  })

  it('registers a projection unit', () => {
    const harness = makeContext()
    apply(harness.ctx, { section: 'policy text' })
    expect(harness.registerCalls.count).toBe(1)
  })

  it('registers the policy section and renders only while active', () => {
    const harness = makeContext()
    apply(harness.ctx, { section: 'policy text' })
    const section = harness.sections[0]
    expect(section?.name).toBe('debug:policy')
    expect(section?.order).toBe(DEBUG_POLICY_ORDER)
    expect(section?.text({})).toBe('')
    harness.state.active = true
    expect(section?.text({ agent: { session: { id: 's1' } } })).toBe('policy text')
    harness.state.active = false
    expect(section?.text({ agent: { session: { id: 's1' } } })).toBe('')
  })

  it('treats a missing projection state as inactive', () => {
    const harness = makeContext({ noState: true })
    apply(harness.ctx, { section: 'policy text' })
    const section = harness.sections[0]
    expect(section?.text({ agent: { session: { id: 's1' } } })).toBe('')
    expect(handleDebugCommand(harness.ctx, makeAgent(), 'why', [])).toEqual({
      kind: 'success',
      text: 'Debug mode on. Use /debug off to leave.',
    })
  })

  it('registers the /debug command with attachments', () => {
    const harness = makeContext()
    apply(harness.ctx)
    const command = harness.commands[0]
    expect(command?.name).toBe('debug')
    expect(command?.input).toEqual({ hint: '[off|message]', attachments: true })
    expect(command?.description).toBe('Enter or leave debug mode')
  })

  it('enters debug mode and disables plan mode when plan-mode is composed', () => {
    const harness = makeContext({ initial: { active: false, running: null } })
    const calls: Array<{ active: boolean }> = []
    const agent = makeAgent({
      planMode: {
        set: (_agent: unknown, active: boolean) => {
          calls.push({ active })
          return 'committed'
        },
      },
    })
    const result = handleDebugCommand(harness.ctx, agent, ' checkout crashes ', [])
    expect(result).toEqual({
      kind: 'success',
      text: 'Debug mode on. Use /debug off to leave.',
    })
    expect(calls).toEqual([{ active: false }])
  })

  it('ignores a malformed plan-mode service', () => {
    const harness = makeContext({ initial: { active: false, running: null } })
    expect(handleDebugCommand(harness.ctx, makeAgent({ planMode: 'nope' }), 'why', []).kind).toBe(
      'success',
    )
    expect(
      handleDebugCommand(harness.ctx, makeAgent({ planMode: { set: 'not-a-function' } }), 'why', [])
        .kind,
    ).toBe('success')
  })

  it('steers attachments-only and attachment-free entries', () => {
    const harness = makeContext({ initial: { active: false, running: null } })
    const calls: Array<{ content: readonly unknown[] }> = []
    const withAttachments = makeAgent()
    ;(
      withAttachments as CompatAgent & { steer?(input: { content: readonly unknown[] }): void }
    ).steer = (input) => {
      calls.push({ content: input.content })
    }
    handleDebugCommand(harness.ctx, withAttachments, '', [{ type: 'image', src: 'x' }])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.content).toHaveLength(1)

    const empty = makeAgent()
    let steered = false
    ;(empty as CompatAgent & { steer?(input: unknown): void }).steer = () => {
      steered = true
    }
    handleDebugCommand(harness.ctx, empty, '', [])
    expect(steered).toBe(false)
  })

  it('entering debug mode without plan-mode does not fail', () => {
    const harness = makeContext({ initial: { active: false, running: null } })
    expect(handleDebugCommand(harness.ctx, makeAgent(), 'why', []).kind).toBe('success')
  })

  it('reports already-active and already-inactive states', () => {
    const active = makeContext({ initial: { active: true, running: null } })
    expect(handleDebugCommand(active.ctx, makeAgent(), 'x', [])).toEqual({
      kind: 'success',
      text: 'Debug mode is already active. Use /debug off to leave.',
    })
    const inactive = makeContext({ initial: { active: false, running: null } })
    expect(handleDebugCommand(inactive.ctx, makeAgent(), 'off', [])).toEqual({
      kind: 'success',
      text: 'Debug mode is already inactive.',
    })
  })

  it('turns debug mode off', () => {
    const harness = makeContext({ initial: { active: true, running: null } })
    expect(handleDebugCommand(harness.ctx, makeAgent(), 'off', [])).toEqual({
      kind: 'success',
      text: 'Debug mode off. Use /debug to turn it back on.',
    })
  })

  it('rejects attachments with /debug off', () => {
    const harness = makeContext()
    const result = handleDebugCommand(harness.ctx, makeAgent(), 'off', [{ type: 'image' }])
    expect(result).toEqual({
      kind: 'error',
      text: 'Attachments cannot accompany /debug off.',
    })
  })

  it('accepts the registered command invocation shape', () => {
    const harness = makeContext()
    apply(harness.ctx)
    const command = harness.commands[0]
    expect(command).toBeDefined()
    if (command === undefined) return
    const invocation: CompatCommandInvocation = {
      agent: makeAgent(),
      rawInput: 'off',
      attachments: [],
    }
    const result = command.handler(invocation)
    expect(result.kind).toBe('success')
  })
})
