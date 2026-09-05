/**
 * Composer debug toggle riding the `conversation.input.left` list seat next to
 * the official Plan chip. The toggle shows the effective collaboration mode;
 * clicking switches to debug (exiting plan mode first through the safe
 * transition sequence) or back to normal. State rides the host debug and plan
 * projections through the standard-kit `useProjection` prop.
 *
 * @module dsh-debug-mode/client/ui
 */

import { useState } from 'react'
import type { ClientProjectionValue } from '../compat/client-context.ts'
import type { DebugToggleKey } from './locales.ts'
import { currentMode, transitionLines } from './logic.ts'

/** Full component props: standard-kit projection hook, locale seat, injected execute face. */
export interface DebugToggleProps {
  /** Host projection hook bound by the renderer standard kit. */
  useProjection: (key: 'debug' | 'plan') => ClientProjectionValue | undefined
  /** Framework-synthesized dictionary reader for this entry's namespace. */
  t: (key: DebugToggleKey) => string
  /** Execute one slash-command line on the session the seat serves. */
  execute: (line: string) => Promise<string | null>
}

const styles = {
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    border: '1px solid #c7c7c7',
    borderRadius: 999,
    background: 'transparent',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '20px',
    color: 'inherit',
    cursor: 'pointer',
  } as const,
  active: {
    borderColor: 'transparent',
    background: 'var(--dsw-alias-state-warn-tertiary, #f3e8c8)',
    color: 'var(--dsw-alias-state-warn-label, #7a5b00)',
  } as const,
}

/** Render the mode toggle for the composer tool row. */
export function ModeControl({ useProjection, t, execute }: DebugToggleProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debug = useProjection('debug')
  const plan = useProjection('plan')
  const mode = currentMode(debug, plan)

  const active = mode === 'debug'
  const labelKey: DebugToggleKey =
    mode === 'debug' ? 'mode.debug' : mode === 'plan' ? 'mode.plan' : 'mode.normal'
  const ariaKey: DebugToggleKey =
    mode === 'debug' ? 'aria.debugOn' : mode === 'plan' ? 'aria.switchFromPlan' : 'aria.enterDebug'
  const label = t(labelKey)

  const toggle = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    const lines = active ? ['/debug off'] : transitionLines(mode, 'debug')
    void executeSequence(execute, lines).then((failure) => {
      setBusy(false)
      if (failure !== null) setError(`${t('failure')}: ${failure}`)
    })
  }

  return (
    <span>
      <button
        type="button"
        style={active ? { ...styles.trigger, ...styles.active } : styles.trigger}
        aria-label={t(ariaKey)}
        title={t(ariaKey)}
        disabled={busy}
        onClick={toggle}
      >
        {label}
      </button>
      {error === null ? null : (
        <span role="status" title={error}>
          {t('failure')}
        </span>
      )}
    </span>
  )
}

/** Run a command sequence in order, stopping at the first failure. */
async function executeSequence(
  execute: (line: string) => Promise<string | null>,
  lines: readonly string[],
): Promise<string | null> {
  for (const line of lines) {
    const failure = await execute(line)
    if (failure !== null) return `${line}: ${failure}`
  }
  return null
}
