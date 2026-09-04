/**
 * Structural type surface of the DeepSeek Harness seam this plugin consumes.
 * Deliberately free of runtime harness imports: the bundle runs inside the
 * harness Loader, which supplies these services by context keys. The types
 * mirror the 0.1.3-alpha.1 API surface and are validated by integration tests
 * that boot the plugin inside a real harness profile.
 *
 * @module dsh-debug-mode/compat
 */

/** One plugin-owned command the human command plane can execute. */
export interface CompatCommandInvocation {
  readonly agent: CompatAgent
  readonly rawInput: string
  readonly attachments: readonly unknown[]
}

/** Result the command plane renders directly. */
export type CompatCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** A live agent whose session this plugin may switch modes on. */
export interface CompatAgent {
  readonly session: { readonly id: string }
  readonly ctx: {
    get(name: string): unknown
  }
  /** Present on agents the loop exposes to plugin code. */
  readonly steer?: (input: { content: readonly unknown[]; source: { kind: 'user' } }) => void
}

/** Optional per-agent plan-mode service provided by the deployment. */
export interface CompatPlanModeService {
  set(...args: unknown[]): unknown
}

/** The harness root context members this plugin uses. */
export interface CompatHostContext {
  readonly sessionProjections: {
    register(definition: unknown): () => void
    stateOf(session: { readonly id: string }, key: string): unknown
  }
  readonly systemPrompt: {
    section(section: {
      name: string
      order: number
      text(context: { agent?: { session: { readonly id: string } } }): string
    }): () => void
  }
  inject(services: readonly string[], callback: (ctx: { commands: CompatCommands }) => void): void
}

/** Command registry supplied to the optional command child. */
export interface CompatCommands {
  register(definition: {
    name: string
    description: string
    input?: { hint: string; attachments?: boolean }
    handler(invocation: CompatCommandInvocation): CompatCommandResult
  }): void
}
