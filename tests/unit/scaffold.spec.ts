import { describe, expect, it } from 'vitest'
import { apply as applyClient, name as clientName } from '../../src/client.js'
import { apply as applyHost, name as hostName } from '../../src/index.js'

describe('stage-one package scaffold', () => {
  it('exports inert host and client plugin entries', () => {
    expect(hostName).toBe('dsh-debug-mode')
    expect(clientName).toBe('dsh-debug-mode-client')
    expect(applyHost()).toBeUndefined()
    expect(applyClient()).toBeUndefined()
  })
})
