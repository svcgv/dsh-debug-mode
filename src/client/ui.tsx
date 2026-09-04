/**
 * Composer debug toggle riding the `conversation.input.left` list seat next to
 * the official Plan chip. The toggle shows Debug when debug mode is active and
 * Normal otherwise; entering Debug first turns plan mode off by executing the
 * safe transition sequence.
 *
 * @module dsh-debug-mode/client/ui
 */

import { useState } from 'react'
import type { ClientProjectionValue } from '../compat/client-context.ts'
import { currentMode, effectiveTarget, transitionLines } from './logic.ts'

export interface DebugToggleProps {
  /** Generic host projection hook bound by the renderer standard kit. */
  useProjection: (key: 'debug' | 'plan') => ClientProjectionValue | undefined
  /** Composer locked state passed by the seat owner. */
  locked: boolean
  /** Execute one slash-command line on the session the seat serves. */
  execute: (line: string) => Promise<string | null>
}

const styles = {
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    border: '1px solid #c7c7c7',
    borderRadius: 8,
    background: 'transparent',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
  } as const,
}

/** Render the Debug / Normal composer toggle. */
export function ModeControl({ useProjection, locked, execute }: DebugToggleProps) {
  const [error, setError] = useState<string | null>(null)
  const debug = useProjection('debug')
  const plan = useProjection('plan')
  const active = debug === undefined ? false : effectiveTarget(debug.active, debug.pending)
  const label = active ? 'Debug' : 'Normal'

  const toggle = (): void => {
    setError(null)
    const lines = active ? ['/debug off'] : transitionLines(currentMode(debug, plan), 'debug')
    void runSequence(execute, lines).then((failure) => setError(failure))
  }

  return (
    <span>
      <button type="button" style={styles.trigger} disabled={locked} onClick={toggle}>
        {label}
      </button>
      {error === null ? null : <span role="alert">{error}</span>}
    </span>
  )
}

/** Run a command sequence in order, stopping at the first failure. */
async function runSequence(
  execute: (line: string) => Promise<string | null>,
  lines: readonly string[],
): Promise<string | null> {
  for (const line of lines) {
    const failure = await execute(line)
    if (failure !== null) return `${line}: ${failure}`
  }
  return null
}
