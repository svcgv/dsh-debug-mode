/**
 * Composer mode selector occupying the conversation-declared
 * `conversation.input.plan` single seat. Renders Normal / Plan / Debug and
 * drives exclusivity by executing the safe command sequence returned by the
 * pure transition logic.
 *
 * @module dsh-debug-mode/client/ui
 */

import { useState } from 'react'
import type { ClientProjectionValue } from '../compat/client-context.ts'
import { currentMode, transitionLines, type DebugUiMode } from './logic.ts'

export interface ModeControlProps {
  /** Generic host projection hook bound by the renderer standard kit. */
  useProjection: (key: 'debug' | 'plan') => ClientProjectionValue | undefined
  /** Composer locked (busy or frozen) state passed by the seat owner. */
  locked: boolean
  /** Execute one slash-command line on the session the seat serves. */
  execute: (line: string) => Promise<string | null>
}

const OPTIONS: ReadonlyArray<{ mode: DebugUiMode; label: string }> = [
  { mode: 'normal', label: 'Normal' },
  { mode: 'plan', label: 'Plan' },
  { mode: 'debug', label: 'Debug' },
]

const styles = {
  wrap: { position: 'relative', display: 'inline-block' } as const,
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 8px',
    border: '1px solid #c7c7c7',
    borderRadius: 8,
    background: 'transparent',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
  } as const,
  menu: {
    position: 'absolute',
    right: 0,
    bottom: 'calc(100% + 4px)',
    margin: 0,
    padding: 4,
    listStyle: 'none',
    border: '1px solid #c7c7c7',
    borderRadius: 8,
    background: '#1f1f1f',
    color: '#f2f2f2',
    minWidth: 120,
    zIndex: 10,
  } as const,
  item: {
    display: 'block',
    width: '100%',
    padding: '6px 10px',
    border: 0,
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  } as const,
}

/** Render the Normal / Plan / Debug composer selector. */
export function ModeControl({ useProjection, locked, execute }: ModeControlProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mode = currentMode(useProjection('debug'), useProjection('plan'))
  const label = OPTIONS.find((option) => option.mode === mode)?.label ?? 'Normal'

  const select = (target: DebugUiMode): void => {
    setOpen(false)
    setError(null)
    const lines = transitionLines(mode, target)
    if (lines.length === 0) return
    void runSequence(execute, lines).then((failure) => {
      setError(failure)
    })
  }

  const trigger = (
    <button
      type="button"
      style={styles.trigger}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={locked}
      onClick={() => setOpen((value) => !value)}
    >
      {label}
      <span aria-hidden>&#9662;</span>
    </button>
  )

  if (!open) {
    return (
      <span style={styles.wrap}>
        {trigger}
        {error === null ? null : <span role="alert">{error}</span>}
      </span>
    )
  }

  return (
    <span style={styles.wrap}>
      {trigger}
      <ul style={styles.menu} role="menu">
        {OPTIONS.map((option) => (
          <li key={option.mode} role="none">
            <button
              type="button"
              role="menuitem"
              style={styles.item}
              aria-current={mode === option.mode}
              onClick={() => select(option.mode)}
            >
              {option.label}
            </button>
          </li>
        ))}
      </ul>
    </span>
  )
}

/**
 * Run a command sequence in order, stopping at the first failure and
 * returning its line. The sequence is at most two commands (exclusivity
 * transitions), so the tail recursion is bounded by construction.
 */
async function runSequence(
  execute: (line: string) => Promise<string | null>,
  lines: readonly string[],
): Promise<string | null> {
  const head = lines[0]
  if (head === undefined) return null
  const failure = await execute(head)
  return failure === null ? runSequence(execute, lines.slice(1)) : `${head}: ${failure}`
}
