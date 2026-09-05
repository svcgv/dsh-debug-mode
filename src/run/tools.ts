/**
 * Model-facing debug tools. The tool catalog stays registered in every mode
 * (request-cache stability); each execute path first checks the committed
 * debug projection for the calling agent and otherwise fails loudly. Parsed
 * arguments are narrowed with explicit runtime guards, never assertions.
 *
 * @module dsh-debug-mode/run/tools
 */

import type { CompatHostContext } from '../compat/host-context.ts'
import { DEBUG_PROJECTION_KEY } from '../mode/fold.ts'
import { parseDebugUnitState } from '../mode/fold.ts'
import type { DebugUnitState } from '../mode/types.ts'
import type { DebugRunManager } from './manager.ts'
import type {
  DebugControlAction,
  DebugControlRequest,
  DebugFinishOutcome,
  DebugStartRequest,
  DebugTarget,
} from './types.ts'

/** Execution identity the registry supplies to tool bodies. */
export interface CompatToolExec {
  readonly agent?: { readonly session: { readonly id: string } }
  readonly signal: AbortSignal
}

/** A registered tool definition this plugin owns. */
export interface DebugToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
    readonly additionalProperties?: boolean
  }
  readonly output: {
    readonly schema: { readonly type: 'string' }
    render(_args: unknown, value: unknown): ReadonlyArray<{ type: 'text'; text: string }>
  }
  execute(args: unknown, exec: CompatToolExec): Promise<string>
}

const CONTROL_ACTIONS: readonly DebugControlAction[] = [
  'status',
  'wait',
  'read',
  'switch_endpoint',
  'reinstrument',
  'continue',
  'next',
  'step_in',
  'step_out',
  'stack',
  'scopes',
  'evaluate',
]

function isControlAction(value: string): value is DebugControlAction {
  return (CONTROL_ACTIONS as readonly string[]).includes(value)
}

function renderText(_args: unknown, value: unknown): ReadonlyArray<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: String(value) }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function asInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`${name} must be an integer`)
  return value
}

export function parseTargets(value: unknown): readonly DebugTarget[] {
  if (!Array.isArray(value)) throw new Error('targets must be an array')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`targets[${index}] must be an object`)
    const startLine = asInt(entry.startLine, `targets[${index}].startLine`)
    const endLine = asInt(entry.endLine, `targets[${index}].endLine`)
    return { path: asString(entry.path, `targets[${index}].path`), startLine, endLine }
  })
}

export function parseStartArgs(value: unknown): DebugStartRequest {
  if (!isRecord(value)) throw new Error('debug_start arguments must be an object')
  const runtime = asString(value.runtime, 'runtime')
  if (runtime !== 'frontend' && runtime !== 'backend' && runtime !== 'auto') {
    throw new Error('runtime must be "auto", "frontend", or "backend"')
  }
  return {
    targets: parseTargets(value.targets),
    runtime,
    ...(value.launchId === undefined ? {} : { launchId: asString(value.launchId, 'launchId') }),
    ...(value.stopExisting === undefined ? {} : { stopExisting: value.stopExisting === true }),
  }
}

export function parseControlArgs(value: unknown): DebugControlRequest {
  if (!isRecord(value)) throw new Error('debug_control arguments must be an object')
  const action = asString(value.action, 'action')
  if (!isControlAction(action)) {
    throw new Error(`action must be one of: ${CONTROL_ACTIONS.join(', ')}`)
  }
  return {
    action,
    ...(value.cursor === undefined ? {} : { cursor: asString(value.cursor, 'cursor') }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: asInt(value.timeoutMs, 'timeoutMs') }),
    ...(value.frameId === undefined ? {} : { frameId: asString(value.frameId, 'frameId') }),
    ...(value.expression === undefined
      ? {}
      : { expression: asString(value.expression, 'expression') }),
  }
}

export function parseFinishArgs(value: unknown): DebugFinishOutcome {
  if (!isRecord(value)) throw new Error('debug_finish arguments must be an object')
  const outcome = asString(value.outcome, 'outcome')
  if (outcome !== 'diagnosed' && outcome !== 'verified' && outcome !== 'cancelled') {
    throw new Error('outcome must be "diagnosed", "verified", or "cancelled"')
  }
  return outcome
}

/** Require debug mode committed for the calling agent and return its session id. */
export function requireDebugActive(ctx: CompatHostContext, exec: CompatToolExec): string {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('debug tools require a calling agent (no session to debug)')
  }
  const raw = ctx.sessionProjections.stateOf(agent.session, DEBUG_PROJECTION_KEY)
  if (raw === undefined) throw new Error('debug mode is not active in this session')
  const state: DebugUnitState = parseDebugUnitState(raw)
  if (!state.active) throw new Error('debug mode is not active in this session; run /debug first')
  return agent.session.id
}

function failureText(code: string, message: string): string {
  return `[${code}] ${message}`
}

/** Build the three tool definitions bound to one manager and host context. */
export function debugToolDefinitions(
  ctx: CompatHostContext,
  manager: DebugRunManager,
): readonly DebugToolDefinition[] {
  return [
    {
      name: 'debug_start',
      description:
        'Start a debug run for located source ranges. Frontend runs instrument the located statements and open a trace listener; backend runs prepare a debugger launch.',
      parameters: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            description: '1-5 located source ranges to instrument or break.',
          },
          runtime: { type: 'string', description: 'Runtime family: auto, frontend, or backend.' },
          launchId: { type: 'string', description: 'Optional launch configuration id.' },
          stopExisting: {
            type: 'boolean',
            description:
              'Backend only: set true only after showing the user the running process and restart command from a CONFIRMATION_REQUIRED result and receiving explicit confirmation. Stops the ordinary service and restarts it on debug_finish.',
          },
        },
        required: ['targets', 'runtime'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const sessionId = requireDebugActive(ctx, exec)
        const result = await manager.start(sessionId, parseStartArgs(args))
        if (result.kind === 'error') return failureText(result.code, result.message)
        return result.notice
      },
    },
    {
      name: 'debug_control',
      description: 'Read bounded runtime evidence or drive stepping on the active debug run.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: `One of: ${CONTROL_ACTIONS.join(', ')}.` },
          cursor: {
            type: 'string',
            description: 'Opaque continuation cursor from the previous read.',
          },
          timeoutMs: { type: 'number', description: 'Bounded wait budget for wait/read.' },
          frameId: { type: 'string', description: 'Stack frame for scopes/evaluate.' },
          expression: { type: 'string', description: 'Expression to evaluate.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const sessionId = requireDebugActive(ctx, exec)
        const result = await manager.control(sessionId, parseControlArgs(args))
        if (result.kind === 'error') return failureText(result.code, result.message)
        return result.text
      },
    },
    {
      name: 'debug_finish',
      description:
        'Finish the active debug run: remove probes and platform configuration, stop listeners and debug processes, and restore a stopped ordinary service unless told otherwise.',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            description: 'How the run ended: diagnosed, verified, or cancelled.',
          },
          restartService: {
            type: 'boolean',
            description: 'Restore a stopped ordinary service (default true).',
          },
        },
        required: ['outcome'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const sessionId = requireDebugActive(ctx, exec)
        const result = await manager.finish(sessionId, parseFinishArgs(args))
        if (result.kind === 'error') return failureText(result.code, result.message)
        const suffix =
          result.couldNotRestore.length === 0
            ? ''
            : ` Could not restore: ${result.couldNotRestore.join(', ')}`
        return `${result.summary}${suffix}`
      },
    },
  ]
}
