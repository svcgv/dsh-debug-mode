import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeBackendRuntime, parseDebuggerWsUrl } from '../../../src/runtime/node-backend.ts'

describe('node backend helpers', () => {
  it('extracts the inspector websocket url', () => {
    expect(parseDebuggerWsUrl('Debugger listening on ws://127.0.0.1:53315/abc\nFor help...')).toBe(
      'ws://127.0.0.1:53315/abc',
    )
    expect(parseDebuggerWsUrl('no debugger')).toBeUndefined()
  })
})

describe('NodeBackendRuntime integration', () => {
  let directory: string
  let file: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-node-'))
    file = join(directory, 'service.js')
    await writeFile(
      file,
      [
        "const http = require('http')",
        "const fs = require('fs')",
        "const path = require('path')",
        'function handle(req, res) {',
        '  const value = 42',
        "  res.end('ok' + value)",
        '}',
        'const server = http.createServer(handle)',
        "server.listen(0, '127.0.0.1', () => {",
        '  const { port } = server.address()',
        "  fs.writeFileSync(path.join(__dirname, 'port.txt'), String(port))",
        '})',
        'setInterval(() => {}, 1000)',
        '',
      ].join('\n'),
      'utf8',
    )
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it(
    'attaches, pauses on traffic, evaluates, and stops the child',
    { timeout: 60_000 },
    async () => {
      const runtime = new NodeBackendRuntime('node-run-1')
      // Break on res.end, after `value` is initialized, so locals are
      // inspectable at the first stop without stepping first.
      const started = await runtime.start({
        targets: [{ path: file, startLine: 6, endLine: 6 }],
        runtime: 'backend',
      })
      if (started.kind !== 'ok') throw new Error(`start failed: ${started.message}`)
      let finishError: unknown
      try {
        let port = ''
        for (let attempt = 0; attempt < 100 && port === ''; attempt += 1) {
          try {
            port = (await readFile(join(directory, 'port.txt'), 'utf8')).trim()
          } catch {
            await new Promise((ok) => setTimeout(ok, 100))
          }
        }
        expect(port).not.toBe('')

        void fetch(`http://127.0.0.1:${port}/`).catch(() => null)
        const paused = await runtime.control('wait', { action: 'wait', timeoutMs: 10_000 })
        if (paused.kind !== 'ok') throw new Error(`wait failed: ${paused.message}`)
        expect(paused.text).toContain('Paused')

        // Evaluate on the first stop; stepping past res.end may resume the
        // service before a second stop exists, so inspect locals while paused.
        const evaluated = await runtime.control('evaluate', {
          action: 'evaluate',
          expression: 'value',
          timeoutMs: 10_000,
        })
        if (evaluated.kind !== 'ok') throw new Error(`evaluate failed: ${evaluated.message}`)
        expect(evaluated.text).toBe('42')

        const stepped = await runtime.control('next', { action: 'next', timeoutMs: 10_000 })
        if (stepped.kind !== 'ok') throw new Error(`step failed: ${stepped.message}`)
        expect(stepped.text).toContain('Paused')
      } finally {
        const finished = await runtime.finish('cancelled')
        if (finished.kind !== 'ok') finishError = new Error(`finish failed: ${finished.message}`)
      }
      if (finishError !== undefined) {
        if (finishError instanceof Error) throw finishError
        throw new Error(typeof finishError === 'string' ? finishError : JSON.stringify(finishError))
      }
    },
  )
})
