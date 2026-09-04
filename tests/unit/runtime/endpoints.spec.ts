import { describe, expect, it } from 'vitest'
import {
  discoverLanAddresses,
  endpointCandidates,
  isLoopbackCandidate,
} from '../../../src/runtime/endpoints.ts'

describe('listener endpoint selection', () => {
  it('prefers loopback and appends each LAN address once', () => {
    const interfaces = [
      { family: 'IPv4', address: '127.0.0.1', internal: true },
      { family: 'IPv4', address: '192.168.1.7', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.1.7', internal: false },
      { family: 'IPv4', address: '169.254.1.1', internal: false },
      { family: 'IPv4', address: '127.0.0.1', internal: false },
    ]
    expect(discoverLanAddresses(interfaces)).toEqual(['192.168.1.7', '169.254.1.1'])
    expect(endpointCandidates(interfaces, 43127)).toEqual([
      'http://127.0.0.1:43127',
      'http://192.168.1.7:43127',
      'http://169.254.1.1:43127',
    ])
  })

  it('drops loopback-only and internal tables', () => {
    expect(
      discoverLanAddresses([{ family: 'IPv4', address: '127.0.0.1', internal: true }]),
    ).toEqual([])
    expect(isLoopbackCandidate('http://127.0.0.1:9')).toBe(true)
    expect(isLoopbackCandidate('http://192.168.1.7:9')).toBe(false)
  })
})
