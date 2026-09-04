import { describe, expect, it } from 'vitest'
import type { CompatCommands, CompatHostContext } from '../../src/compat/host-context.ts'
import { apply, inject, name } from '../../src/host.ts'

type RegisteredSection = Parameters<CompatHostContext['systemPrompt']['section']>[0]

describe('host entry', () => {
  it('re-exports the controller identity and root service declarations', () => {
    expect(name).toBe('dsh-debug-mode')
    expect(inject).toEqual(['sessionProjections', 'systemPrompt'])
    expect(apply).toBeTypeOf('function')
  })

  it('registers projection, policy, and command wiring', () => {
    const state = { active: true, running: null }
    const sections: RegisteredSection[] = []
    let registerCalls = 0
    const ctx: CompatHostContext = {
      tools: { register: () => undefined },
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
  })
})
