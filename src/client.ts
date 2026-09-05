/**
 * Browser entry of the dsh-debug-mode bundle: rides the conversation
 * `conversation.input.left` list seat with a Debug / Normal toggle beside the
 * official Plan chip. State rides the host debug and plan projections;
 * entering Debug executes the safe transition sequence that turns plan mode
 * off first. Copy rides the active locale through one registered dictionary
 * namespace.
 *
 * @module dsh-debug-mode/client
 */

import type { CompatClientContext, ClientCommandOutcome } from './compat/client-context.ts'
import { en, NS, zh } from './client/locales.ts'
import { ModeControl } from './client/ui.tsx'

export const name = 'dsh-debug-mode-client'

/** Required browser services: the slot registry, command Remote, and locale registry. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale']

/** Stable list-entry id in the `conversation.input.left` seat. */
export const ENTRY_ID = 'debug-mode'

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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-debug-mode: dictionaries')
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: ENTRY_ID,
        locale: NS,
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
