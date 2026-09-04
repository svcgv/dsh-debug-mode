import { describe, expect, it } from 'vitest'
import { apply as applyClient, name as clientName } from '../../src/client.ts'
import { apply as applyRoster, name as rosterName } from '../../src/index.ts'

describe('package entries', () => {
  it('exports the reserved roster identity with an inert node apply', () => {
    expect(rosterName).toBe('dsh-debug-mode')
    expect(applyRoster()).toBeUndefined()
  })

  it('exports the browser plugin identity', () => {
    expect(clientName).toBe('dsh-debug-mode-client')
    expect(applyClient).toBeTypeOf('function')
  })
})
