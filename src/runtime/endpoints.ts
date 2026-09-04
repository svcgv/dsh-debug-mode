/**
 * Listener endpoint selection: the runtime always advertises loopback first
 * and falls back to a reachable LAN address when no heartbeat arrives. LAN
 * discovery is pure over an interface table so the fallback is testable
 * without platform I/O.
 *
 * @module dsh-debug-mode/runtime/endpoints
 */

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
