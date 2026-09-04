/**
 * Structural type surface of the browser-side harness seam this plugin uses:
 * the composer slot registry, the remote command executor, and the generic
 * projection hook the renderer binds into registered components. No runtime
 * harness import; the bundle is served by the client modules system, which
 * resolves the underlying services by context keys.
 *
 * @module dsh-debug-mode/compat/client
 */

/** Client-visible value of a host projection unit. */
export interface ClientProjectionValue {
  readonly active: boolean
  readonly pending: boolean
}

/** Outcome of one remote command execution. */
export interface ClientCommandOutcome {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly message: string; readonly code?: string }
}

/** Face the composer seat exposes to registered components. */
export interface ClientExecuteFace {
  /** Execute one slash-command line and return an inline failure, if any. */
  execute(line: string): Promise<string | null>
}

/** The browser root context members this plugin uses. */
export interface CompatClientContext {
  readonly slots: {
    inject(name: string, factory: () => unknown): void
    register(
      spec: {
        name: string
        locale?: string
        inject(sessionId: string): ClientExecuteFace
      },
      component: unknown,
    ): unknown
  }
  readonly remote: {
    readonly commands: {
      execute(
        sessionId: string,
        line: string,
        attachments: readonly unknown[],
      ): Promise<ClientCommandOutcome>
    }
  }
}
