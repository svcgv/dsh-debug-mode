/**
 * Pure client-side mode decision logic for the composer selector. Kept free
 * of React so it is unit-testable and does not pull DOM types into the core
 * coverage lane.
 *
 * @module dsh-debug-mode/client/logic
 */

import type { ClientProjectionValue } from '../compat/client-context.ts'

/** The three collaboration modes the selector offers. */
export type DebugUiMode = 'normal' | 'plan' | 'debug'

/** Effective target of a projection pair: pending flips the committed state. */
export function effectiveTarget(active: boolean, pending: boolean): boolean {
  return pending ? !active : active
}

/** Resolve the single active mode from the debug and plan projections. */
export function currentMode(
  debug: ClientProjectionValue | undefined,
  plan: ClientProjectionValue | undefined,
): DebugUiMode {
  if (debug !== undefined && effectiveTarget(debug.active, debug.pending)) return 'debug'
  if (plan !== undefined && effectiveTarget(plan.active, plan.pending)) return 'plan'
  return 'normal'
}

/** The command lines needed to move from one mode to another, in order. */
export function transitionLines(from: DebugUiMode, to: DebugUiMode): readonly string[] {
  if (from === to) return []
  if (to === 'normal') {
    const lines: string[] = []
    if (from === 'debug') lines.push('/debug off')
    if (from === 'plan') lines.push('/plan off')
    return lines
  }
  if (to === 'debug') {
    const lines: string[] = []
    if (from === 'plan') lines.push('/plan off')
    lines.push('/debug')
    return lines
  }
  const lines: string[] = []
  if (from === 'debug') lines.push('/debug off')
  lines.push('/plan')
  return lines
}
