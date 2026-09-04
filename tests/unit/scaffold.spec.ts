import { describe, expect, it } from 'vitest'
import { apply as applyClient, name as clientName } from '../../src/client.ts'
import { apply as applyHost, name as hostName } from '../../src/index.ts'

describe('package entries', () => {
  it('exports the reserved host plugin identity', () => {
    expect(hostName).toBe('dsh-debug-mode')
    expect(applyHost).toBeTypeOf('function')
  })

  it('keeps the browser entry inert until the UI milestone', () => {
    expect(clientName).toBe('dsh-debug-mode-client')
    expect(applyClient()).toBeUndefined()
  })
})
