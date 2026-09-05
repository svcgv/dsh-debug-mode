import { describe, expect, it } from 'vitest'
import { BackendRouterRuntime } from '../../../src/runtime/backend-router.ts'
import {
  PythonBackendRuntime,
  pickDebuggeeSocketPort,
  reservePort,
} from '../../../src/runtime/python-backend.ts'

describe('python backend helpers', () => {
  it('reserves an ephemeral TCP port', async () => {
    const port = await reservePort()
    expect(port).toBeGreaterThan(0)
  })

  it('picks the non-internal debuggee socket from a debugpySockets body', () => {
    expect(
      pickDebuggeeSocketPort(
        {
          sockets: [
            { host: '127.0.0.1', port: 5000, internal: false },
            { host: '127.0.0.1', port: 5001, internal: true },
          ],
        },
        1234,
      ),
    ).toBe(5000)
  })

  it('falls back to the listen port when no debuggee socket is advertised', () => {
    expect(pickDebuggeeSocketPort(undefined, 4321)).toBe(4321)
    expect(pickDebuggeeSocketPort({ sockets: [] }, 4321)).toBe(4321)
    expect(pickDebuggeeSocketPort({ sockets: [{ port: 5000, internal: true }] }, 4321)).toBe(4321)
    expect(pickDebuggeeSocketPort({ sockets: 'nope' }, 4321)).toBe(4321)
  })
})

describe('PythonBackendRuntime error paths', () => {
  it('rejects non-python targets', async () => {
    const runtime = new PythonBackendRuntime('py-run', 'python3')
    const result = await runtime.start({
      targets: [{ path: 'service.ts', startLine: 1, endLine: 2 }],
      runtime: 'backend',
    })
    expect(result).toMatchObject({ kind: 'error', code: 'UNSUPPORTED_TARGET' })
  })

  it('fails loudly when debugpy is unavailable', async () => {
    const runtime = new PythonBackendRuntime('py-run', 'no-such-python-dsh')
    const result = await runtime.start({
      targets: [{ path: 'service.py', startLine: 1, endLine: 2 }],
      runtime: 'backend',
    })
    expect(result).toMatchObject({ kind: 'error', code: 'RUNTIME_UNAVAILABLE' })
    expect(result.kind === 'error' && result.message).toContain('debugpy')
  })
})

describe('backend router', () => {
  it('reports missing runs and idle finishes', async () => {
    const router = new BackendRouterRuntime('route-1')
    expect(await router.control('status', { action: 'status' })).toMatchObject({
      kind: 'error',
      code: 'NO_ACTIVE_RUN',
    })
    const finished = await router.finish('cancelled')
    if (finished.kind !== 'ok') throw new Error('finish failed')
    expect(finished.summary).toContain('No backend run')
  })
})
