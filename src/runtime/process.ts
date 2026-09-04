/**
 * Process discovery helpers for the backend debuggers. Discovery is read-only
 * and conservative: the backend never auto-kills a process it did not start.
 * When an existing ordinary service runs the same target script, start fails
 * with an instruction instead of silently double-launching.
 *
 * @module dsh-debug-mode/runtime/process
 */

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

/** One discovered process row. */
export interface ProcessRow {
  readonly pid: number
  readonly command: string
}

/** Parse the default `ps -axo pid=,command=` output. */
export function parsePsRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (Number.isSafeInteger(pid) && command !== '') rows.push({ pid, command })
  }
  return rows
}

/** Whether a command line runs an ordinary (non-inspector) service for scriptPath. */
export function isOrdinaryServiceCommand(command: string, scriptPath: string): boolean {
  if (command.includes('--inspect')) return false
  if (command.includes('debugpy --listen')) return false
  if (!command.includes(scriptPath)) return false
  return true
}

/** Find ordinary service pids running the resolved script. */
export function findServicePids(rows: ProcessRow[], scriptPath: string, ownPid: number): number[] {
  const resolved = resolve(scriptPath)
  return rows
    .filter((row) => row.pid !== ownPid && isOrdinaryServiceCommand(row.command, resolved))
    .map((row) => row.pid)
}

/** Read the current POSIX process table. */
export function listProcesses(): Promise<ProcessRow[]> {
  return new Promise((ok, fail) => {
    execFile('ps', ['-axo', 'pid=,command='], (error, stdout) => {
      if (error !== null) {
        const detail = error instanceof Error ? error.message : JSON.stringify(error)
        fail(new Error(detail))
        return
      }
      ok(parsePsRows(stdout))
    })
  })
}
