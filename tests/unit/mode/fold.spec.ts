import { describe, expect, it } from 'vitest'
import type { DebugUnitState } from '../../../src/mode/types.ts'
import {
  applyDebugEvent,
  debugStateCodec,
  initDebugUnitState,
  isOffCommand,
  parseDebugIntent,
  parseDebugUnitState,
  toErrorMessage,
  viewDebugProjection,
} from '../../../src/mode/fold.ts'

function runEvent(commandId: string, args: string) {
  return { type: 'command/run', data: { commandId, name: 'debug', args } }
}
function doneEvent(commandId: string, kind: 'success' | 'error') {
  return { type: 'command/done', data: { commandId, kind } }
}

describe('debug mode fold', () => {
  it('starts inactive with no running command', () => {
    expect(initDebugUnitState()).toEqual({ active: false, running: null })
    expect(viewDebugProjection(initDebugUnitState())).toEqual({ active: false, pending: false })
  })

  it('marks a pending target while a /debug command runs and commits on success', () => {
    let state = initDebugUnitState()
    state = applyDebugEvent(state, runEvent('c1', ' the bug is in checkout '))
    expect(state.running).toEqual({ commandId: 'c1', wanted: true })
    expect(viewDebugProjection(state)).toEqual({ active: false, pending: true })
    state = applyDebugEvent(state, doneEvent('c1', 'success'))
    expect(state).toEqual({ active: true, running: null })
    expect(viewDebugProjection(state)).toEqual({ active: true, pending: false })
  })

  it('commits an off selection and clears pending', () => {
    let state: DebugUnitState = { active: true, running: null }
    state = applyDebugEvent(state, runEvent('c2', 'off'))
    expect(viewDebugProjection(state)).toEqual({ active: true, pending: true })
    state = applyDebugEvent(state, doneEvent('c2', 'success'))
    expect(state).toEqual({ active: false, running: null })
    expect(viewDebugProjection(state)).toEqual({ active: false, pending: false })
  })

  it('keeps the committed state when the command fails', () => {
    let state: DebugUnitState = { active: false, running: null }
    state = applyDebugEvent(state, runEvent('c3', ' inspect checkout '))
    state = applyDebugEvent(state, doneEvent('c3', 'error'))
    expect(state).toEqual({ active: false, running: null })
  })

  it('ignores unrelated events and stale completions', () => {
    let state = initDebugUnitState()
    state = applyDebugEvent(state, { type: 'user/message', data: { name: 'debug' } })
    expect(state).toEqual(initDebugUnitState())
    state = applyDebugEvent(state, runEvent('c4', 'on'))
    state = applyDebugEvent(state, doneEvent('stale', 'success'))
    expect(state.running?.commandId).toBe('c4')
    state = applyDebugEvent(state, { type: 'command/run', data: { name: 'plan' } })
    expect(state.running?.commandId).toBe('c4')
  })

  it('handles run events without args by keeping state', () => {
    const state = applyDebugEvent(initDebugUnitState(), {
      type: 'command/run',
      data: { commandId: 'c5', name: 'debug' },
    })
    expect(state).toEqual(initDebugUnitState())
  })

  it('does not overwrite a newer running command with a stale completion', () => {
    let state = initDebugUnitState()
    state = applyDebugEvent(state, runEvent('c6', 'first'))
    state = applyDebugEvent(state, runEvent('c7', 'second'))
    state = applyDebugEvent(state, doneEvent('c6', 'success'))
    expect(state.running).toEqual({ commandId: 'c7', wanted: true })
    expect(state.active).toBe(false)
  })

  it('handles completions without a running command and malformed done records', () => {
    const idle = applyDebugEvent(initDebugUnitState(), doneEvent('c9', 'success'))
    expect(idle).toEqual(initDebugUnitState())
    const malformedDone = applyDebugEvent(initDebugUnitState(), {
      type: 'command/done',
      data: { commandId: 7, kind: 'success' },
    })
    expect(malformedDone).toEqual(initDebugUnitState())
    const malformedKind = applyDebugEvent(initDebugUnitState(), {
      type: 'command/done',
      data: { commandId: 'c10', kind: 3 },
    })
    expect(malformedKind).toEqual(initDebugUnitState())
    const nonStringArgs = applyDebugEvent(initDebugUnitState(), {
      type: 'command/run',
      data: { commandId: 'c11', name: 'debug', args: 12 },
    })
    expect(nonStringArgs).toEqual(initDebugUnitState())
  })

  it('keeps state when a run event lacks a command id', () => {
    const state = applyDebugEvent(initDebugUnitState(), {
      type: 'command/run',
      data: { name: 'debug', args: 'checkout' },
    })
    expect(state).toEqual(initDebugUnitState())
  })

  it('parses and validates persisted state', () => {
    const state = parseDebugUnitState({ active: true, running: { commandId: 'c8', wanted: false } })
    expect(state).toEqual({ active: true, running: { commandId: 'c8', wanted: false } })
    expect(debugStateCodec.parse({ active: false, running: null })).toEqual({
      active: false,
      running: null,
    })
  })

  it('rejects malformed persisted state loudly', () => {
    expect(() => parseDebugUnitState(null)).toThrow(/boolean "active"/)
    expect(() => parseDebugUnitState({ active: 'yes' })).toThrow(/boolean "active"/)
    expect(() => parseDebugUnitState({ active: true, running: { commandId: 1 } })).toThrow(
      /invalid "running"/,
    )
    expect(() =>
      debugStateCodec.parse({ active: true, running: { commandId: 'c', wanted: 'yes' } }),
    ).toThrow(/invalid "running"/)
  })

  it('renders any thrown value as a stable failure line', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
    expect(toErrorMessage('plain')).toBe('plain')
  })

  it('parses command intents and rejects attachments with /debug off', () => {
    expect(parseDebugIntent('', false)).toEqual({ kind: 'enter', message: '' })
    expect(parseDebugIntent('  why does checkout fail? ', false)).toEqual({
      kind: 'enter',
      message: 'why does checkout fail?',
    })
    expect(parseDebugIntent('off', false)).toEqual({ kind: 'exit' })
    expect(parseDebugIntent('  off  ', false)).toEqual({ kind: 'exit' })
    expect(() => parseDebugIntent('off', true)).toThrow(/Attachments cannot accompany \/debug off/)
    expect(isOffCommand('off')).toBe(true)
    expect(isOffCommand('  off  ')).toBe(true)
    expect(isOffCommand('offline')).toBe(false)
    expect(isOffCommand('')).toBe(false)
  })
})
