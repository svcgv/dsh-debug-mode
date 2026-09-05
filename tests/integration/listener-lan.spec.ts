import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIngestHandler } from '../../src/listener/http.ts'
import { TraceStore } from '../../src/listener/store.ts'

/** The machine's first non-loopback IPv4, if one exists (skips on CI hosts without one). */
function lanAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

describe.skipIf(lanAddress() === undefined)('ingest listener over the LAN address', () => {
  const store = new TraceStore()
  const token = 'lan-secret-token'
  let server: ReturnType<typeof createServer>
  let port = 0

  beforeAll(async () => {
    server = createServer(createIngestHandler({ store, token }))
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    port = address.port
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  })

  it('accepts a probe batch posted to the non-loopback address', async () => {
    const lan = lanAddress()
    if (lan === undefined) return
    const response = await fetch(`http://${lan}:${port}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://${lan}:8137` },
      body: JSON.stringify({
        token,
        events: [
          { kind: 'probe', runId: 'lan-run', ts: Date.now(), line: 3, file: 'app.js' },
          { kind: 'heartbeat', runId: 'lan-run', ts: Date.now() },
        ],
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const events = store.read(-1, 10).events
    expect(events.some((event) => event.runId === 'lan-run' && event.kind === 'probe')).toBe(true)
  })
})
