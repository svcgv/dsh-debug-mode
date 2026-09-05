/**
 * Host wiring for debug mode: registers the projection unit folded from
 * `/debug` command records, the `debug:policy` prompt section, and the
 * `/debug` and `/debug off` commands. The module stays structural — it never
 * imports a harness package — so its branches are unit-testable with a fake
 * context and the real integration is exercised by booting the bundle inside
 * a harness profile.
 *
 * @module dsh-debug-mode/mode/host
 */

import type { CompatAgent, CompatCommandResult, CompatHostContext } from '../compat/host-context.ts'
import {
  DEBUG_PROJECTION_KEY,
  DEBUG_PROJECTION_STATE_VERSION,
  applyDebugEvent,
  debugStateCodec,
  initDebugUnitState,
  parseDebugIntent,
  parseDebugProjectionView,
  parseDebugUnitState,
  toErrorMessage,
  viewDebugProjection,
} from './fold.ts'
import { DEBUG_POLICY_ORDER, renderDebugPolicy, type DebugPolicyAgentContext } from './policy.ts'
import type { DebugFoldEvent, DebugUnitState } from './types.ts'
import { DebugRunManager } from '../run/manager.ts'
import { resolveDebugRuntime } from '../run/registry.ts'
import { debugToolDefinitions } from '../run/tools.ts'
import { registerBackendRuntime, registerFrontendRuntime } from '../runtime/register.ts'

/** Plugin name surfaced to the loader. */
export const name = 'dsh-debug-mode'

/** Deployment-authored guidance for the debug:policy section. */
export interface DebugModeConfig {
  /** Guidance rendered while debug mode is active. */
  section: string
}

const DEFAULT_SECTION = [
  'You are in debug mode. Debug mode authorizes instrumenting or pausing the project to obtain runtime evidence:',
  '- Locate the smallest relevant code range with searches, LSP, and file reads before changing anything.',
  '- Frontend targets: insert run-scoped probes into the located statements, ask the user to reproduce, then read bounded runtime evidence through debug_control.',
  '- Backend targets: stop the existing service only after showing the recovery plan and receiving explicit confirmation, start the debugger with breakpoints in the located statements, then ask the user to reproduce.',
  '- Diagnose from runtime evidence first; propose a fix only after reporting the root cause, evidence, and confidence.',
  '- Fixes require user choice before editing; verify a fix by re-running the same reproduction.',
  '- debug_finish removes probes, platform configuration, listeners, and debug processes, and restarts a stopped ordinary service unless told otherwise.',
].join('\n')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asDebugEvent(value: unknown): DebugFoldEvent | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  const data = value.data
  if (!isRecord(data)) return undefined
  return {
    type: value.type,
    data: {
      commandId: data.commandId,
      name: data.name,
      args: data.args,
      kind: data.kind,
    },
  }
}

function asUnitState(value: unknown): DebugUnitState {
  return parseDebugUnitState(value)
}

/** Disable plan mode through the deployment's per-agent plan-mode service, when composed. */
function disablePlanMode(agent: CompatAgent): void {
  const service = agent.ctx.get('planMode')
  if (!isRecord(service)) return
  const set = service.set
  if (typeof set !== 'function') return
  // oxlint-disable-next-line typescript/no-unsafe-call -- cross-version dynamic dispatch; guarded by the typeof check above
  set(agent, false)
}

/** Build the projection definition object handed to ctx.sessionProjections.register. */
export function buildDebugProjectionDefinition(): {
  key: string
  stateVersion: number
  stateSchema: { parse(value: unknown): DebugUnitState }
  init(): DebugUnitState
  apply(state: DebugUnitState, event: unknown): DebugUnitState
  wire: {
    viewSchema: { parse(value: unknown): { active: boolean; pending: boolean } }
    view(state: DebugUnitState): { active: boolean; pending: boolean }
  }
} {
  return {
    key: DEBUG_PROJECTION_KEY,
    stateVersion: DEBUG_PROJECTION_STATE_VERSION,
    stateSchema: debugStateCodec,
    init: initDebugUnitState,
    apply: (state, event) => {
      const foldEvent = asDebugEvent(event)
      return foldEvent === undefined ? state : applyDebugEvent(state, foldEvent)
    },
    wire: {
      viewSchema: {
        parse(value: unknown) {
          return parseDebugProjectionView(value)
        },
      },
      view: viewDebugProjection,
    },
  }
}

/** Read the committed debug state for one agent from the projection registry. */
function committedDebugState(ctx: CompatHostContext, agent: CompatAgent): DebugUnitState {
  const state = ctx.sessionProjections.stateOf(agent.session, DEBUG_PROJECTION_KEY)
  return state === undefined ? initDebugUnitState() : asUnitState(state)
}

/** Human outcome for one /debug invocation, mirroring the plan command grammar. */
export function handleDebugCommand(
  ctx: CompatHostContext,
  agent: CompatAgent,
  rawInput: string,
  attachments: readonly unknown[],
): CompatCommandResult {
  let intent: ReturnType<typeof parseDebugIntent>
  try {
    intent = parseDebugIntent(rawInput, attachments.length > 0)
  } catch (error) {
    return { kind: 'error', text: toErrorMessage(error) }
  }
  const state = committedDebugState(ctx, agent)
  if (intent.kind === 'enter') {
    disablePlanMode(agent)
  }
  if (intent.kind === 'enter' && (intent.message !== '' || attachments.length > 0)) {
    agent.steer?.({
      content: [
        ...attachments,
        ...(intent.message === '' ? [] : [{ type: 'text', text: intent.message }]),
      ],
      source: { kind: 'user' },
    })
  }
  if (intent.kind === 'exit') {
    return state.active
      ? { kind: 'success', text: 'Debug mode off. Use /debug to turn it back on.' }
      : { kind: 'success', text: 'Debug mode is already inactive.' }
  }
  return state.active
    ? { kind: 'success', text: 'Debug mode is already active. Use /debug off to leave.' }
    : { kind: 'success', text: 'Debug mode on. Use /debug off to leave.' }
}

/** Register debug-mode projection, prompt section, and commands on one context. */
export function apply(
  ctx: CompatHostContext,
  config: DebugModeConfig = { section: DEFAULT_SECTION },
): void {
  ctx.sessionProjections.register(buildDebugProjectionDefinition())

  ctx.systemPrompt.section({
    name: 'debug:policy',
    order: DEBUG_POLICY_ORDER,
    text: (context: DebugPolicyAgentContext) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const state = ctx.sessionProjections.stateOf(agent.session, DEBUG_PROJECTION_KEY)
      const active = state === undefined ? false : asUnitState(state).active
      return renderDebugPolicy(active, config.section)
    },
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'debug',
      description: 'Enter or leave debug mode',
      input: { hint: '[off|message]', attachments: true },
      handler: ({ agent, rawInput, attachments }) =>
        handleDebugCommand(ctx, agent, rawInput, attachments),
    })
  })

  registerFrontendRuntime()
  registerBackendRuntime()
  const manager = createDebugRunManager()
  for (const definition of debugToolDefinitions(ctx, manager)) {
    ctx.tools.register(definition)
  }
}

/** Build the session run manager backed by the shared runtime registry. */
export function createDebugRunManager(): DebugRunManager {
  return new DebugRunManager((kind, runId) => {
    const factory = resolveDebugRuntime(kind)
    return factory === undefined ? undefined : factory(runId)
  })
}
