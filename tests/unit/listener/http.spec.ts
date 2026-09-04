import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIngestHandler } from '../../../src/listener/http.ts'
import { TraceStore } from '../../../src/listener/store.ts'

function deepValue(): unknown {
  let value: unknown = 'leaf'
  for (let index = 0; index < 25; index += 1) value = [value]
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBody(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('response body is not a record')
  return value
}

describe('ingest handler', () => {
  let server: Server
  let port: number
  let store: TraceStore
  const token = 'secret-token'

  beforeEach(async () => {
    store = new TraceStore()
    server = createServer(createIngestHandler({ store, token }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('server did not bind a TCP port')
    port = address.port
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  })

  async function post(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: text === '' ? {} : parseBody(text) }
  }

  it('accepts an authenticated batch', async () => {
    const response = await post('/ingest', {
      token,
      events: [
        {
          kind: 'probe',
          runId: 'r1',
          ts: 1,
          file: 'a.ts',
          line: 3,
          functionName: 'checkout',
          text: 'step',
          locals: { n: 1 },
        },
        { kind: 'heartbeat', runId: 'r1', ts: 2 },
      ],
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, accepted: 2, dropped: 0 })
    expect(store.count).toBe(2)
  })

  it('rejects payloads above the configured body cap', async () => {
    const small = new TraceStore()
    const smallServer = createServer(createIngestHandler({ store: small, token, maxBodyBytes: 16 }))
    await new Promise<void>((resolve) => smallServer.listen(0, '127.0.0.1', resolve))
    const smallAddress = smallServer.address()
    if (smallAddress === null || typeof smallAddress === 'string')
      throw new Error('small server did not bind')
    const smallPort = smallAddress.port
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const client = httpRequest(
          {
            host: '127.0.0.1',
            port: smallPort,
            path: '/ingest',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (response) => {
            response.resume()
            resolve(response.statusCode ?? 0)
          },
        )
        client.on('error', reject)
        client.write(
          '{"token":"secret-token","events":[{"kind":"probe","runId":"r","ts":1,"text":"',
        )
        client.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        client.write('"}]}')
        client.end()
      })
      expect(status).toBe(413)
    } finally {
      await new Promise<void>((resolve, reject) =>
        smallServer.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    }
  })

  it('reports store drops when the byte cap is hit', async () => {
    const capped = new TraceStore({ maxEvents: 100, maxBytes: 120 })
    const cappedServer = createServer(createIngestHandler({ store: capped, token }))
    await new Promise<void>((resolve) => cappedServer.listen(0, '127.0.0.1', resolve))
    const address = cappedServer.address()
    if (address === null || typeof address === 'string')
      throw new Error('capped server did not bind')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          events: [
            { kind: 'probe', runId: 'r', ts: 1, text: 'x'.repeat(60) },
            { kind: 'probe', runId: 'r', ts: 2, text: 'y'.repeat(60) },
          ],
        }),
      })
      expect(response.status).toBe(200)
      const body = parseBody(await response.text())
      expect(body).toEqual({ ok: true, accepted: 1, dropped: 1 })
    } finally {
      await new Promise<void>((resolve, reject) =>
        cappedServer.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    }
  })

  it('rejects wrong methods, paths, tokens, and bodies', async () => {
    const get = await fetch(`http://127.0.0.1:${port}/ingest`)
    expect(get.status).toBe(405)
    expect((await post('/other', { token, events: [] })).status).toBe(404)
    expect(
      (await post('/ingest', { token: 'bad', events: [{ kind: 'probe', runId: 'r', ts: 1 }] }))
        .status,
    ).toBe(401)
    expect(
      (
        await post('/ingest', {
          token: 'xxxxxxxxxxxx',
          events: [{ kind: 'probe', runId: 'r', ts: 1 }],
        })
      ).status,
    ).toBe(401)
    expect((await post('/ingest', { token })).status).toBe(400)
    const invalid = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    })
    expect(invalid.status).toBe(400)
    expect((await post('/ingest', { token, events: [] })).status).toBe(400)
  })

  it('drops malformed event rows and reports counts', async () => {
    const response = await post('/ingest', {
      token,
      events: [
        { kind: 'probe', runId: 'r1', ts: 1 },
        { kind: 'other', runId: 'r1', ts: 1 },
        { kind: 'probe', runId: 5, ts: 1 },
        { kind: 'probe', runId: 'r1', ts: 'now' },
        { kind: 'probe', runId: 'r1', ts: 1, locals: { a: () => undefined } },
        { kind: 'probe', runId: 'r1', ts: 1, locals: { s: 'x', flag: true, nil: null } },
        { kind: 'probe', runId: 'r1', ts: 1, locals: { arr: [1, 2] } },
        { kind: 'probe', runId: 'r1', ts: 1, locals: { deep: deepValue() } },
        42,
      ],
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, accepted: 5, dropped: 4 })
  })
})
