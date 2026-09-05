/**
 * Process discovery helpers for the backend debuggers. Discovery is read-only
 * and conservative: the backend never auto-kills a process it did not start.
 * When an existing ordinary service runs the same target script, start fails
 * with an instruction instead of silently double-launching.
 *
 * @module dsh-debug-mode/runtime/process
 */

import { execFile } from 'node:child_process'
import { basename, resolve } from 'node:path'

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
  const resolved = resolve(scriptPath)
  if (command.includes(resolved)) return true
  // A service launched from its project directory with a relative script
  // (e.g. `node sample-service.js`) never contains the absolute path, so
  // fall back to the script basename for interpreter commands.
  const base = basename(resolved)
  return /(?:^|\s)node(?:\.exe)?(?:\s|$)|(?:^|\s)python/.test(command) && command.includes(base)
}

/** Find ordinary service pids running the resolved script. */
export function findServicePids(rows: ProcessRow[], scriptPath: string, ownPid: number): number[] {
  const resolved = resolve(scriptPath)
  return rows
    .filter((row) => row.pid !== ownPid && isOrdinaryServiceCommand(row.command, resolved))
    .map((row) => row.pid)
}

/** Build the PowerShell command that lists processes with command lines. */
export function windowsProcessListArgs(): readonly string[] {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress'
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse PowerShell ConvertTo-Json output into process rows. */
export function parseWindowsProcessList(output: string): ProcessRow[] {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const rows: ProcessRow[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (typeof entry.ProcessId !== 'number' || typeof entry.CommandLine !== 'string') continue
    rows.push({ pid: entry.ProcessId, command: entry.CommandLine })
  }
  return rows
}

/** Build taskkill arguments for one pid (graceful then force). */
export function windowsKillArgs(pid: number, force: boolean): readonly string[] {
  return force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T']
}

/**
 * Terminate one process by pid, waiting for exit with a force fallback.
 * Platform differences live in this adapter: POSIX uses SIGTERM then SIGKILL,
 * Windows uses taskkill with the process tree.
 * @param pid - target pid (never the caller's own process).
 */
export function killProcessPid(pid: number): Promise<void> {
  return new Promise((ok) => {
    if (process.platform === 'win32') {
      execFile('taskkill', windowsKillArgs(pid, false), (killError) => {
        if (killError !== null) {
          execFile('taskkill', windowsKillArgs(pid, true), () => ok())
          return
        }
        ok()
      })
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      ok()
      return
    }
    const force = setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
      clearInterval(poll)
      ok()
    }, 5_000)
    const poll = setInterval(() => {
      try {
        process.kill(pid, 0)
      } catch {
        clearInterval(poll)
        clearTimeout(force)
        ok()
      }
    }, 200)
  })
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
