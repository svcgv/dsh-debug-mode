import { describe, expect, it } from 'vitest'
import {
  findServicePids,
  isOrdinaryServiceCommand,
  parsePsRows,
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
  })

  it('finds service pids excluding the current process', () => {
    const rows = parsePsRows('  10 node /srv/app.js\n  11 node --inspect /srv/app.js\n')
    expect(findServicePids(rows, '/srv/app.js', 10)).toEqual([])
    expect(findServicePids(rows, '/srv/app.js', 99)).toEqual([10])
  })
})
