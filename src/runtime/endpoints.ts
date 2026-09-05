/**
 * Listener endpoint selection. The reproduction scope comes from the model's
 * reading of the user's description: a local repro uses loopback only, a
 * device/LAN repro uses a reachable LAN address (the user picks when several
 * exist), and auto keeps the legacy loopback-first order with heartbeat
 * rotation to a LAN candidate. LAN discovery is pure over an interface table
 * so every branch is testable without platform I/O.
 *
 * @module dsh-debug-mode/runtime/endpoints
 */

import type { DebugReproductionScope } from '../run/types.ts'

/** One discovered network interface. */
export interface NetworkInterfaceView {
  readonly family: string
  readonly address: string
  readonly internal: boolean
}

/** Build the ordered endpoint candidates for one listener port. */
export function endpointCandidates(
  interfaces: ReadonlyArray<NetworkInterfaceView>,
  port: number,
): readonly string[] {
  const lan = discoverLanAddresses(interfaces)
  return [`http://127.0.0.1:${port}`, ...lan.map((address) => `http://${address}:${port}`)]
}

/** Non-loopback IPv4 addresses reachable on the local network. */
export function discoverLanAddresses(
  interfaces: ReadonlyArray<NetworkInterfaceView>,
): readonly string[] {
  const addresses: string[] = []
  for (const entry of interfaces) {
    if (entry.internal) continue
    if (entry.family !== 'IPv4') continue
    const address = entry.address
    if (address === '127.0.0.1') continue
    if (addresses.includes(address)) continue
    addresses.push(address)
  }
  return addresses
}

/** Whether a candidate is the loopback endpoint. */
export function isLoopbackCandidate(candidate: string): boolean {
  return candidate.startsWith('http://127.0.0.1:')
}

/** Outcome of resolving the endpoint plan for one run. */
export type EndpointPlan =
  | { readonly kind: 'ready'; readonly endpoints: readonly string[]; readonly notice: string }
  | { readonly kind: 'lan-selection-required'; readonly candidates: readonly string[] }
  | { readonly kind: 'no-lan' }
  | {
      readonly kind: 'invalid-lan'
      readonly requested: string
      readonly candidates: readonly string[]
    }

const LOOPBACK_NOTICE =
  'The reproduction is local, so probes report to the loopback listener (127.0.0.1).'

/** Resolve which listener endpoints a run should advertise, given the scope
 * the model inferred from the user's description.
 * @param interfaces - current interface table (non-loopback IPv4 = LAN).
 * @param port - listener port.
 * @param scope - local/lan/auto; auto keeps loopback-first rotation.
 * @param lanAddress - the user-chosen LAN address after a selection prompt.
 */
export function resolveEndpointPlan(
  interfaces: ReadonlyArray<NetworkInterfaceView>,
  port: number,
  scope: DebugReproductionScope,
  lanAddress?: string,
): EndpointPlan {
  const lan = discoverLanAddresses(interfaces)
  if (scope === 'local') {
    return { kind: 'ready', endpoints: [`http://127.0.0.1:${port}`], notice: LOOPBACK_NOTICE }
  }
  if (scope === 'lan') {
    if (lanAddress !== undefined) {
      if (lan.includes(lanAddress)) {
        return {
          kind: 'ready',
          endpoints: [`http://${lanAddress}:${port}`],
          notice: `The user will reproduce from another device, so probes report to the LAN listener at ${lanAddress}.`,
        }
      }
      return { kind: 'invalid-lan', requested: lanAddress, candidates: lan }
    }
    if (lan.length === 0) return { kind: 'no-lan' }
    if (lan.length === 1) {
      return {
        kind: 'ready',
        endpoints: [`http://${lan[0]}:${port}`],
        notice: `The user will reproduce from another device, so probes report to the LAN listener at ${lan[0]}.`,
      }
    }
    return { kind: 'lan-selection-required', candidates: lan }
  }
  return {
    kind: 'ready',
    endpoints: endpointCandidates(interfaces, port),
    notice:
      'Probes report to the loopback listener first and rotate to a LAN address if no heartbeat arrives.',
  }
}
