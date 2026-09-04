/**
 * Debug-mode prompt policy: a deployment-authored section that is rendered
 * only while debug mode is active for the calling agent. Pure decision logic
 * is separated from the host registration so tests need no Cordis context.
 *
 * @module dsh-debug-mode/mode/policy
 */

/** Sort order for the debug policy prompt section. */
export const DEBUG_POLICY_ORDER = 510

/** Render the policy section only when debug mode is active. */
export function renderDebugPolicy(active: boolean, section: string): string {
  return active ? section : ''
}

/** Prompt-assembly context projection the host fold understands. */
export interface DebugPolicyAgentContext {
  readonly agent?: { readonly session: { readonly id: string } }
}
