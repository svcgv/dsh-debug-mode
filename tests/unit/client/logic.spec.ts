import { describe, expect, it } from 'vitest'
import { currentMode, effectiveTarget, transitionLines } from '../../../src/client/logic.ts'

describe('client mode logic', () => {
  it('computes effective targets from pending projections', () => {
    expect(effectiveTarget(false, false)).toBe(false)
    expect(effectiveTarget(true, false)).toBe(true)
    expect(effectiveTarget(false, true)).toBe(true)
    expect(effectiveTarget(true, true)).toBe(false)
  })

  it('resolves the active mode, giving debug precedence over plan', () => {
    expect(currentMode(undefined, undefined)).toBe('normal')
    expect(currentMode(undefined, { active: true, pending: false })).toBe('plan')
    expect(currentMode({ active: true, pending: false }, undefined)).toBe('debug')
    expect(currentMode({ active: true, pending: true }, undefined)).toBe('normal')
    expect(currentMode({ active: false, pending: true }, { active: true, pending: false })).toBe(
      'debug',
    )
  })

  it('builds transition command sequences in the safe order', () => {
    expect(transitionLines('normal', 'normal')).toEqual([])
    expect(transitionLines('debug', 'debug')).toEqual([])
    expect(transitionLines('debug', 'normal')).toEqual(['/debug off'])
    expect(transitionLines('plan', 'normal')).toEqual(['/plan off'])
    expect(transitionLines('plan', 'debug')).toEqual(['/plan off', '/debug'])
    expect(transitionLines('debug', 'plan')).toEqual(['/debug off', '/plan'])
    expect(transitionLines('normal', 'debug')).toEqual(['/debug'])
    expect(transitionLines('normal', 'plan')).toEqual(['/plan'])
  })
})
