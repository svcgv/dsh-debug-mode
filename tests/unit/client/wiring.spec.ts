import { describe, expect, it } from 'vitest'
import type {
  ClientCommandOutcome,
  CompatClientContext,
} from '../../../src/compat/client-context.ts'
import { apply, failureFromOutcome, inject, name } from '../../../src/client.ts'

function makeContext(outcome?: ClientCommandOutcome): {
  ctx: CompatClientContext
  slot: {
    name: string | undefined
    inject(sessionId: string): { execute(line: string): Promise<string | null> } | undefined
  }
  executed: string[]
} {
  const executed: string[] = []
  const slot = {
    name: undefined as string | undefined,
    injectFactory: undefined as
      ((sessionId: string) => { execute(line: string): Promise<string | null> }) | undefined,
  }
  const ctx: CompatClientContext = {
    slots: {
      inject: (_name: string, factory: () => unknown) => {
        factory()
      },
      register: (registration) => {
        slot.name = registration.name
        slot.injectFactory = (id: string) => registration.inject(id)
        return undefined
      },
    },
    remote: {
      commands: {
        execute: (_sessionId: string, line: string) => {
          executed.push(line)
          return Promise.resolve(outcome ?? { ok: true })
        },
      },
    },
  }
  return {
    ctx,
    slot: {
      get name() {
        return slot.name
      },
      inject: (sessionId: string) => slot.injectFactory?.(sessionId),
    },
    executed,
  }
}

describe('client wiring', () => {
  it('exports the browser plugin identity and services', () => {
    expect(name).toBe('dsh-debug-mode-client')
    expect(inject).toEqual(['slots', 'remote', 'remote.commands'])
    expect(apply).toBeTypeOf('function')
  })

  it('registers the conversation plan seat with an execute face', async () => {
    const harness = makeContext()
    apply(harness.ctx)
    expect(harness.slot.name).toBe('conversation.input.plan')
    expect(harness.slot.inject('session-1')).toBeDefined()
    const face = harness.slot.inject('session-1')
    if (face === undefined) return
    await expect(face.execute('/debug')).resolves.toBeNull()
    expect(harness.executed).toEqual(['/debug'])
  })

  it('maps remote failures to inline error text', async () => {
    const harness = makeContext({ ok: false, error: { message: 'rejected', code: 'E' } })
    apply(harness.ctx)
    const face = harness.slot.inject('session-1')
    if (face === undefined) return
    await expect(face.execute('/debug')).resolves.toBe('rejected (E)')
  })

  it('maps command outcomes to stable inline failures', () => {
    expect(failureFromOutcome({ ok: true })).toBeNull()
    expect(failureFromOutcome({ ok: false })).toBe('unknown command failure')
    expect(failureFromOutcome({ ok: false, error: { message: 'nope' } })).toBe('nope')
    expect(failureFromOutcome({ ok: false, error: { message: 'nope', code: 'E_X' } })).toBe(
      'nope (E_X)',
    )
  })
})
