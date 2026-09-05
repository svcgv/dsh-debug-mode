import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeBackendRuntime, parseDebuggerWsUrl } from '../../../src/runtime/node-backend.ts'
import { findServicePids, listProcesses } from '../../../src/runtime/process.ts'

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

  beforeAll(async () => {
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

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it(
    'attaches, pauses on traffic, evaluates, and stops the child',
    { timeout: 60_000 },
    async () => {
      const runtime = new NodeBackendRuntime('node-run-1')
      // Break on res.end, after `value` is initialized, so locals are
      // inspectable at the first stop without depending on a step landing.
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

        const evaluated = await runtime.control('evaluate', {
          action: 'evaluate',
          expression: 'value',
          timeoutMs: 10_000,
        })
        if (evaluated.kind !== 'ok') throw new Error(`evaluate failed: ${evaluated.message}`)
        expect(evaluated.text).toBe('42')

        // Resuming completes the request; a later reproduction would pause again.
        const continued = await runtime.control('continue', {
          action: 'continue',
          timeoutMs: 5_000,
        })
        if (continued.kind !== 'ok') throw new Error(`continue failed: ${continued.message}`)
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

  it(
    'confirmation-gated stop of an ordinary service and restart on finish',
    { timeout: 60_000 },
    async () => {
      const ordinary = spawn(process.execPath, [file], {
        cwd: dirname(file),
        stdio: 'ignore',
      })
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

        const runtime = new NodeBackendRuntime('confirm-run')
        const first = await runtime.start({
          targets: [{ path: file, startLine: 6, endLine: 6 }],
          runtime: 'backend',
        })
        expect(first.kind).toBe('error')
        if (first.kind === 'error') expect(first.code).toBe('CONFIRMATION_REQUIRED')

        // The ordinary service is untouched until the caller confirms.
        expect(isAlive(ordinary.pid ?? -1)).toBe(true)

        const started = await runtime.start({
          targets: [{ path: file, startLine: 6, endLine: 6 }],
          runtime: 'backend',
          stopExisting: true,
        })
        if (started.kind !== 'ok') throw new Error(`start failed: ${started.message}`)
        expect(isAlive(ordinary.pid ?? -1)).toBe(false)

        const finished = await runtime.finish('cancelled')
        if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.message}`)
        expect(finished.restored.join(' ')).toContain('restarted')

        // The revived service re-listens on a fresh port and answers; poll
        // because the port file is rewritten asynchronously after spawn.
        let response: Response | null = null
        for (let attempt = 0; attempt < 100 && response === null; attempt += 1) {
          let revivedPort = ''
          try {
            revivedPort = (await readFile(join(directory, 'port.txt'), 'utf8')).trim()
          } catch {
            // not rewritten yet
          }
          if (revivedPort !== '') {
            response = await fetch(`http://127.0.0.1:${revivedPort}/`).catch(() => null)
          }
          if (response === null) await new Promise((ok) => setTimeout(ok, 150))
        }
        expect(response?.status).toBe(200)
      } finally {
        if (ordinary.pid !== undefined) {
          try {
            ordinary.kill('SIGKILL')
          } catch {
            // already gone
          }
        }
        try {
          const rows = await listProcesses()
          for (const pid of findServicePids(rows, file, process.pid)) {
            if (pid === ordinary.pid) continue
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
              // already gone
            }
          }
        } catch {
          // process-table reads are best-effort during teardown
        }
      }
    },
  )
})

function isAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
