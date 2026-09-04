import { describe, expect, it } from 'vitest'
import { CdpClient, CdpError, type CdpSocket } from '../../../src/runtime/cdp.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFrame(raw: string): { id: number; method: string | undefined } {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) throw new Error('bad frame')
  if (typeof value.id !== 'number') throw new Error('missing id')
  return { id: value.id, method: typeof value.method === 'string' ? value.method : undefined }
}

class FakeSocket implements CdpSocket {
  sent: string[] = []
  closed = false
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
}

describe('CDP client', () => {
  it('correlates commands by id and resolves results', async () => {
    const socket = new FakeSocket()
    const client = new CdpClient(socket)
    const result = client.send('Runtime.evaluate', { expression: '1 + 1' })
    const frame = parseFrame(socket.sent[0] ?? '')
    expect(frame.method).toBe('Runtime.evaluate')
    client.handleFrame(JSON.stringify({ id: frame.id, result: { result: { value: 2 } } }))
    await expect(result).resolves.toEqual({ result: { value: 2 } })
    client.close()
  })

  it('rejects command errors', async () => {
    const socket = new FakeSocket()
    const client = new CdpClient(socket)
    const result = client.send('Debugger.resume')
    const frame = parseFrame(socket.sent[0] ?? '')
    client.handleFrame(
      JSON.stringify({ id: frame.id, error: { code: -32000, message: 'not paused' } }),
    )
    await expect(result).rejects.toBeInstanceOf(CdpError)
    client.close()
  })

  it('dispatches events to listeners and waiters', async () => {
    const socket = new FakeSocket()
    const client = new CdpClient(socket)
    const seen: string[] = []
    client.onEvent((method) => seen.push(method))
    const paused = client.waitForEvent('Debugger.paused', 100)
    client.handleFrame(JSON.stringify({ method: 'Debugger.scriptParsed', params: { url: 'a.js' } }))
    client.handleFrame(
      JSON.stringify({ method: 'Debugger.paused', params: { reason: 'breakpoint' } }),
    )
    await expect(paused).resolves.toEqual({ reason: 'breakpoint' })
    expect(seen).toEqual(['Debugger.scriptParsed', 'Debugger.paused'])
    client.close()
  })

  it('rejects after close and ignores malformed frames', async () => {
    const socket = new FakeSocket()
    const client = new CdpClient(socket)
    const pending = client.send('Debugger.resume')
    client.handleFrame('not json')
    client.handleFrame(JSON.stringify({ nope: true }))
    client.close()
    await expect(pending).rejects.toThrow(/closed/)
    expect(socket.closed).toBe(true)
    client.handleFrame(JSON.stringify({ method: 'x', params: {} }))
  })
})
