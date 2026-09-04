import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PythonBackendRuntime } from '../../src/runtime/python-backend.ts'

const PY = process.env.PY_DEBUGPY ?? ''
const enabled = PY !== ''

describe.skipIf(!enabled)('PythonBackendRuntime debugpy integration', () => {
  let directory: string
  let file: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-py-'))
    file = join(directory, 'service.py')
    await writeFile(
      file,
      [
        'import http.server',
        'import os',
        '',
        'class H(http.server.BaseHTTPRequestHandler):',
        '    def do_GET(self):',
        '        answer = 42',
        '        data = b"ok"',
        '        self.send_response(200)',
        '        self.send_header("Content-Length", str(len(data)))',
        '        self.end_headers()',
        '        self.wfile.write(data)',
        '',
        '    def log_message(self, fmt, *args):',
        '        pass',
        '',
        'server = http.server.HTTPServer(("127.0.0.1", 0), H)',
        'port = server.server_address[1]',
        'open(os.path.join(os.path.dirname(__file__), "port.txt"), "w").write(str(port))',
        'server.serve_forever()',
        '',
      ].join('\n'),
      'utf8',
    )
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('attaches, pauses on traffic, evaluates, and stops', async () => {
    const runtime = new PythonBackendRuntime('py-run-1', PY)
    const started = await runtime.start({
      targets: [{ path: file, startLine: 7, endLine: 7 }],
      runtime: 'backend',
    })
    if (started.kind !== 'ok') throw new Error(`start failed: ${started.message}`)
    let finishError: unknown
    try {
      let port = ''
      for (let attempt = 0; attempt < 100 && port === ''; attempt += 1) {
        try {
          const { readFile } = await import('node:fs/promises')
          port = (await readFile(join(directory, 'port.txt'), 'utf8')).trim()
        } catch {
          await new Promise((ok) => setTimeout(ok, 100))
        }
      }
      expect(port).not.toBe('')
      void fetch(`http://127.0.0.1:${port}/`).catch(() => null)

      const paused = await runtime.control('wait', { action: 'wait', timeoutMs: 20_000 })
      if (paused.kind !== 'ok') throw new Error(`wait failed: ${paused.message}`)
      expect(paused.text).toContain('Stopped')

      const stepped = await runtime.control('next', { action: 'next', timeoutMs: 20_000 })
      if (stepped.kind !== 'ok') throw new Error(`step failed: ${stepped.message}`)
      expect(stepped.text).toContain('Stopped')

      const evaluated = await runtime.control('evaluate', {
        action: 'evaluate',
        expression: 'answer',
      })
      if (evaluated.kind !== 'ok') throw new Error(`evaluate failed: ${evaluated.message}`)
      expect(evaluated.text).toBe('42')
    } finally {
      const finished = await runtime.finish('diagnosed')
      if (finished.kind !== 'ok') finishError = new Error(`finish failed: ${finished.message}`)
    }
    if (finishError !== undefined) {
      if (finishError instanceof Error) throw finishError
      throw new Error(typeof finishError === 'string' ? finishError : JSON.stringify(finishError))
    }
  })
})
