/**
 * Structural type surface of the browser-side harness seam this plugin uses:
 * the composer slot registry, the remote command executor, the locale
 * registry, and the generic projection hook the renderer binds into
 * registered components. No runtime harness import; the bundle is served by
 * the client modules system, which resolves the underlying services by
 * context keys.
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

/** One plugin-owned dictionary pair registered under a namespace. */
export interface ClientLocaleDictionary {
  readonly zh: Readonly<Record<string, string>>
  readonly en: Readonly<Record<string, string>>
}

/** Structural root context shape this plugin consumes. */
export interface CompatClientContext {
  /** Cordis effect seat used to scope the locale registration to the fiber. */
  effect(fn: () => unknown, label?: string): void
  readonly slots: {
    inject(name: string, factory: () => unknown): void
    register(
      spec: {
        name: string
        /** List seats require a stable entry id; single seats omit it. */
        id?: string
        locale?: string
        /** Session-scope seats receive the current session id. */
        inject(sessionId: string): ClientExecuteFace
      },
      component: unknown,
    ): unknown
  }
  readonly locale: {
    register(namespace: string, dictionary: ClientLocaleDictionary): unknown
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
