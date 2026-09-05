import { describe, expect, it } from 'vitest'
import type {
  ClientCommandOutcome,
  CompatClientContext,
} from '../../../src/compat/client-context.ts'
import { ENTRY_ID, apply, failureFromOutcome, inject, name } from '../../../src/client.ts'

function makeContext(outcome?: ClientCommandOutcome): {
  ctx: CompatClientContext
  slot: {
    name: string | undefined
    id: string | undefined
    locale: string | undefined
    inject(sessionId: string): { execute(line: string): Promise<string | null> } | undefined
  }
  localeNamespaces: string[]
  executed: string[]
} {
  const executed: string[] = []
  const localeNamespaces: string[] = []
  const slot = {
    name: undefined as string | undefined,
    id: undefined as string | undefined,
    locale: undefined as string | undefined,
    injectFactory: undefined as
      ((sessionId: string) => { execute(line: string): Promise<string | null> }) | undefined,
  }
  const ctx: CompatClientContext = {
    effect: (fn: () => unknown) => {
      fn()
    },
    slots: {
      inject: (_name: string, factory: () => unknown) => {
        factory()
      },
      register: (registration) => {
        slot.name = registration.name
        slot.id = registration.id
        slot.locale = registration.locale
        slot.injectFactory = (id: string) => registration.inject(id)
        return undefined
      },
    },
    locale: {
      register: (namespace: string) => {
        localeNamespaces.push(namespace)
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
      get id() {
        return slot.id
      },
      get locale() {
        return slot.locale
      },
      inject: (sessionId: string) => slot.injectFactory?.(sessionId),
    },
    localeNamespaces,
    executed,
  }
}

describe('client wiring', () => {
  it('exports the browser plugin identity and services', () => {
    expect(name).toBe('dsh-debug-mode-client')
    expect(inject).toEqual(['slots', 'remote', 'remote.commands', 'locale'])
    expect(apply).toBeTypeOf('function')
  })

  it('registers a dictionary namespace and the composer seat with a stable entry id', () => {
    const harness = makeContext()
    apply(harness.ctx)
    expect(harness.localeNamespaces).toEqual(['dsh-debug'])
    expect(harness.slot.name).toBe('conversation.input.left')
    expect(harness.slot.id).toBe(ENTRY_ID)
    expect(harness.slot.locale).toBe('dsh-debug')
  })

  it('registers the conversation seat with an execute face', async () => {
    const harness = makeContext()
    apply(harness.ctx)
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
