import { describe, expect, it } from 'vitest'
import type { CompatCommands, CompatHostContext } from '../../src/compat/host-context.ts'
import { apply, inject, name } from '../../src/host.ts'

type RegisteredSection = Parameters<CompatHostContext['systemPrompt']['section']>[0]

describe('host entry', () => {
  it('re-exports the controller identity and root service declarations', () => {
    expect(name).toBe('dsh-debug-mode')
    expect(inject).toEqual(['sessionProjections', 'systemPrompt', 'tools'])
    expect(apply).toBeTypeOf('function')
  })

  it('registers projection, policy, command, and tool wiring', () => {
    const state = { active: true, running: null }
    const sections: RegisteredSection[] = []
    const tools: string[] = []
    let registerCalls = 0
    const ctx: CompatHostContext = {
      tools: {
        register: (definition) => {
          tools.push(definition.name)
        },
      },
      sessionProjections: {
        register: () => {
          registerCalls += 1
          return () => undefined
        },
        stateOf: () => state,
      },
      systemPrompt: {
        section: (section) => {
          sections.push(section)
          return () => undefined
        },
      },
      inject: (_services, callback) => {
        const commands: CompatCommands = {
          register: () => undefined,
        }
        callback({ commands })
      },
    }
    apply(ctx, { section: 'policy text' })
    expect(registerCalls).toBe(1)
    expect(sections[0]?.name).toBe('debug:policy')
    expect(sections[0]?.text({ agent: { session: { id: 's1' } } })).toBe('policy text')
    expect(tools).toEqual(['debug_start', 'debug_control', 'debug_finish'])
  })
})
