import { describe, expect, it } from 'vitest'
import { DapClient, DapError, type DapTransport } from '../../../src/runtime/dap.ts'

class FakeTransport implements DapTransport {
  written = ''
  closed = false
  write(data: Buffer | string): void {
    this.written += typeof data === 'string' ? data : data.toString('utf8')
  }
  close(): void {
    this.closed = true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function frame(message: unknown): string {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

function extractRequest(transport: FakeTransport): { seq: number; command: string } {
  const match = /\r\n\r\n(.*)$/s.exec(transport.written)
  if (match === null) throw new Error('no frame written')
  const parsed: unknown = JSON.parse(match[1] ?? '')
  if (!isRecord(parsed)) throw new Error('bad request')
  if (typeof parsed.seq !== 'number' || typeof parsed.command !== 'string')
    throw new Error('bad request fields')
  return { seq: parsed.seq, command: parsed.command }
}

describe('DAP client', () => {
  it('sends framed requests and resolves responses', async () => {
    const transport = new FakeTransport()
    const client = new DapClient(transport)
    const result = client.send('initialize', { adapterID: 'debugpy' })
    const request = extractRequest(transport)
    expect(request.command).toBe('initialize')
    client.feed(
      frame({
        seq: 1,
        type: 'response',
        request_seq: request.seq,
        success: true,
        command: 'initialize',
        body: { supports: [] },
      }),
    )
    await expect(result).resolves.toEqual({ supports: [] })
    client.close()
    expect(transport.closed).toBe(true)
  })

  it('rejects failed responses', async () => {
    const transport = new FakeTransport()
    const client = new DapClient(transport)
    const result = client.send('setBreakpoints')
    const request = extractRequest(transport)
    client.feed(
      frame({
        seq: 2,
        type: 'response',
        request_seq: request.seq,
        success: false,
        command: 'setBreakpoints',
        body: { error: 'bad path' },
      }),
    )
    await expect(result).rejects.toBeInstanceOf(DapError)
    client.close()
  })

  it('dispatches events to waiters across split frames', async () => {
    const transport = new FakeTransport()
    const client = new DapClient(transport)
    const stopped = client.waitForEvent('stopped', 1000)
    const raw = frame({ seq: 3, type: 'event', event: 'stopped', body: { reason: 'breakpoint' } })
    const half = Math.floor(raw.length / 2)
    client.feed(raw.slice(0, half))
    client.feed(raw.slice(half))
    await expect(stopped).resolves.toEqual({ reason: 'breakpoint' })
    client.close()
  })

  it('ignores malformed frames and rejects after close', async () => {
    const transport = new FakeTransport()
    const client = new DapClient(transport)
    const pending = client.send('disconnect')
    client.feed('not a frame')
    const request = extractRequest(transport)
    client.close()
    await expect(pending).rejects.toThrow(/closed/)
    void request
  })
})
