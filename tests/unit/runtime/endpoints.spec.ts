import { describe, expect, it } from 'vitest'
import {
  discoverLanAddresses,
  endpointCandidates,
  isLoopbackCandidate,
  resolveEndpointPlan,
} from '../../../src/runtime/endpoints.ts'

const TWO_LAN = [
  { family: 'IPv4', address: '192.168.1.7', internal: false },
  { family: 'IPv4', address: '10.0.0.8', internal: false },
]

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

  it('resolves local scope to loopback only', () => {
    const plan = resolveEndpointPlan(TWO_LAN, 7000, 'local')
    expect(plan).toMatchObject({ kind: 'ready', endpoints: ['http://127.0.0.1:7000'] })
  })

  it('resolves a single-address lan scope directly', () => {
    const single = [{ family: 'IPv4', address: '192.168.1.7', internal: false }]
    expect(resolveEndpointPlan(single, 7001, 'lan')).toMatchObject({
      kind: 'ready',
      endpoints: ['http://192.168.1.7:7001'],
    })
  })

  it('asks the user to pick when a lan scope has several addresses', () => {
    expect(resolveEndpointPlan(TWO_LAN, 7002, 'lan')).toEqual({
      kind: 'lan-selection-required',
      candidates: ['192.168.1.7', '10.0.0.8'],
    })
  })

  it('honours the user-chosen lan address and rejects unknown ones', () => {
    expect(resolveEndpointPlan(TWO_LAN, 7003, 'lan', '10.0.0.8')).toMatchObject({
      kind: 'ready',
      endpoints: ['http://10.0.0.8:7003'],
    })
    expect(resolveEndpointPlan(TWO_LAN, 7003, 'lan', '192.168.9.9')).toMatchObject({
      kind: 'invalid-lan',
      requested: '192.168.9.9',
      candidates: ['192.168.1.7', '10.0.0.8'],
    })
  })

  it('reports no-lan and keeps auto as loopback-first rotation', () => {
    const loopbackOnly = [{ family: 'IPv4', address: '127.0.0.1', internal: true }]
    expect(resolveEndpointPlan(loopbackOnly, 7004, 'lan')).toEqual({ kind: 'no-lan' })
    expect(resolveEndpointPlan(loopbackOnly, 7004, 'lan', '192.168.1.7')).toMatchObject({
      kind: 'invalid-lan',
    })
    expect(resolveEndpointPlan(TWO_LAN, 7005, 'auto')).toMatchObject({
      kind: 'ready',
      endpoints: ['http://127.0.0.1:7005', 'http://192.168.1.7:7005', 'http://10.0.0.8:7005'],
    })
  })
})
