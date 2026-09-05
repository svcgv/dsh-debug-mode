import { describe, expect, it } from 'vitest'
import { buildDebugProjectionDefinition } from '../../../src/mode/host.ts'

describe('debug projection definition', () => {
  it('folds only structurally valid events and passes through everything else', () => {
    const definition = buildDebugProjectionDefinition()
    const initial = definition.init()
    expect(definition.apply(initial, null)).toBe(initial)
    expect(definition.apply(initial, { type: 7 })).toBe(initial)
    expect(definition.apply(initial, { type: 'x' })).toBe(initial)
    expect(definition.apply(initial, { type: 'command/run', data: {} })).toBe(initial)
    const next = definition.apply(initial, {
      type: 'command/run',
      data: { commandId: 'c1', name: 'debug', args: ' checkout ' },
    })
    expect(next.running?.wanted).toBe(true)
  })

  it('validates the wire view schema against the harness view handoff', () => {
    const definition = buildDebugProjectionDefinition()
    const state = { active: true, running: null as { commandId: string; wanted: boolean } | null }
    const view = definition.wire.view(state)
    expect(view).toEqual({ active: true, pending: false })
    // The gateway hands viewSchema.parse the view of the folded state.
    expect(definition.wire.viewSchema.parse(view)).toEqual({ active: true, pending: false })
    expect(definition.wire.viewSchema.parse({ active: false, pending: true })).toEqual({
      active: false,
      pending: true,
    })
    expect(() => definition.wire.viewSchema.parse({ active: 'yes' })).toThrow(
      /boolean "active" and "pending"/,
    )
  })
})
