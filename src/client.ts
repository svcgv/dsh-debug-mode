/**
 * Browser entry of the dsh-debug-mode bundle: occupies the conversation
 * `conversation.input.plan` single seat with the Normal / Plan / Debug
 * selector. State rides the host debug and plan projections; exclusivity is
 * enforced host-side by `/debug` disabling plan mode and client-side by
 * executing transition commands in the safe order.
 *
 * @module dsh-debug-mode/client
 */

import type { CompatClientContext, ClientCommandOutcome } from './compat/client-context.ts'
import { ModeControl } from './client/ui.tsx'

export const name = 'dsh-debug-mode-client'

/** Required browser services: the slot registry and the command Remote. */
export const inject = ['slots', 'remote', 'remote.commands']

/** Map one remote command outcome to an inline error or null. */
export function failureFromOutcome(outcome: ClientCommandOutcome): string | null {
  if (outcome.ok) return null
  const error = outcome.error
  return error === undefined
    ? 'unknown command failure'
    : `${error.message}${error.code === undefined ? '' : ` (${error.code})`}`
}

/** Browser plugin body. */
export function apply(ctx: CompatClientContext): void {
  ctx.slots.inject('conversation.input.plan', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.plan',
        inject: (sessionId: string) => ({
          execute: async (line: string): Promise<string | null> => {
            const outcome = await ctx.remote.commands.execute(sessionId, line, [])
            return failureFromOutcome(outcome)
          },
        }),
      },
      ModeControl,
    ),
  )
}
