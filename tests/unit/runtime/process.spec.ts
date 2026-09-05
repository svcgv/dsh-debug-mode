import { describe, expect, it } from 'vitest'
import {
  findServicePids,
  isOrdinaryServiceCommand,
  killProcessPid,
  parsePsRows,
  parseWindowsProcessList,
  windowsKillArgs,
  windowsProcessListArgs,
} from '../../../src/runtime/process.ts'

describe('process discovery helpers', () => {
  it('parses ps rows', () => {
    const rows = parsePsRows('  123 /usr/bin/node /srv/app.js\n  456 node --inspect /srv/app.js\n')
    expect(rows).toEqual([
      { pid: 123, command: '/usr/bin/node /srv/app.js' },
      { pid: 456, command: 'node --inspect /srv/app.js' },
    ])
    expect(parsePsRows('')).toEqual([])
    expect(parsePsRows('not a row')).toEqual([])
  })

  it('classifies ordinary services and ignores inspectors and self', () => {
    expect(isOrdinaryServiceCommand('node /srv/app.js', '/srv/app.js')).toBe(true)
    expect(isOrdinaryServiceCommand('node --inspect /srv/app.js', '/srv/app.js')).toBe(false)
    expect(
      isOrdinaryServiceCommand('python -m debugpy --listen 1 /srv/app.py', '/srv/app.py'),
    ).toBe(false)
    expect(isOrdinaryServiceCommand('node /other.js', '/srv/app.js')).toBe(false)
    // A service started from its project directory with a relative script.
    expect(isOrdinaryServiceCommand('node sample-service.js', '/srv/sample-service.js')).toBe(true)
    expect(isOrdinaryServiceCommand('python sample-service.py', '/srv/sample-service.py')).toBe(
      true,
    )
    expect(isOrdinaryServiceCommand('node other.js', '/srv/sample-service.js')).toBe(false)
    expect(isOrdinaryServiceCommand('ruby sample-service.js', '/srv/sample-service.js')).toBe(false)
  })

  it('builds windows process commands and parses json output', () => {
    const args = windowsProcessListArgs()
    expect(args[0]).toBe('-NoProfile')
    expect(args.join(' ')).toContain('Get-CimInstance Win32_Process')
    const rows = parseWindowsProcessList(
      JSON.stringify([
        { ProcessId: 1, CommandLine: 'node C:\\srv\\app.js' },
        { ProcessId: 2, CommandLine: 5 },
        'junk',
      ]),
    )
    expect(rows).toEqual([{ pid: 1, command: 'node C:\\srv\\app.js' }])
    expect(parseWindowsProcessList('not json')).toEqual([])
    expect(windowsKillArgs(7, false)).toEqual(['/PID', '7', '/T'])
    expect(windowsKillArgs(7, true)).toEqual(['/PID', '7', '/T', '/F'])
  })

  it('terminates via taskkill on windows and sigterm elsewhere', async () => {
    // Windows branch: taskkill is absent in this environment, so both the
    // graceful and the force fallback error out and the promise resolves.
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      await expect(killProcessPid(999_999_999)).resolves.toBeUndefined()
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original)
      else Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    }
    // POSIX branch against a nonexistent pid resolves without throwing.
    await expect(killProcessPid(999_999_999)).resolves.toBeUndefined()
  })

  it('finds service pids excluding the current process', () => {
    const rows = parsePsRows('  10 node /srv/app.js\n  11 node --inspect /srv/app.js\n')
    expect(findServicePids(rows, '/srv/app.js', 10)).toEqual([])
    expect(findServicePids(rows, '/srv/app.js', 99)).toEqual([10])
  })
})
