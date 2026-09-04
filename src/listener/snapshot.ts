/**
 * Probe payload normalization: depth- and budget-bounded variable snapshots
 * with key-based redaction. Everything the listener persists or the model
 * reads passes through this module first.
 *
 * @module dsh-debug-mode/listener/snapshot
 */

import type { TraceJson } from './types.ts'

/** Default sensitive key patterns (lowercased key checked). */
export const SENSITIVE_KEY_PATTERN =
  /secret|token|password|authorization|cookie|api[_-]?key|private[_-]?key|passwd/i

/** Whether a variable name is sensitive and must be withheld. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

/** Bounds applied to every snapshot. */
export interface SnapshotLimits {
  /** Maximum object/array depth. */
  readonly maxDepth: number
  /** Maximum number of variable entries per object and at the root. */
  readonly maxVars: number
  /** Maximum serialized payload bytes. */
  readonly maxBytes: number
  /** Maximum string length before truncation. */
  readonly maxStringLength: number
}

/** Default snapshot bounds. */
export const DEFAULT_LIMITS: SnapshotLimits = {
  maxDepth: 3,
  maxVars: 12,
  maxBytes: 16 * 1024,
  maxStringLength: 512,
}

/** Result of normalizing one raw probe payload. */
export interface SnapshotResult {
  readonly locals: TraceJson | undefined
  readonly redacted: readonly string[]
  readonly truncated: boolean
}

/** Mutable normalization context shared by one snapshot. */
class Context {
  private bytes = 0
  private truncated = false
  constructor(private readonly limits: SnapshotLimits) {}

  count(value: TraceJson): void {
    this.bytes += JSON.stringify(value).length
    if (this.bytes > this.limits.maxBytes) this.truncated = true
  }

  get exhausted(): boolean {
    return this.truncated
  }

  mark(): void {
    this.truncated = true
  }
}

function scalarValue(value: unknown, maxStringLength: number): TraceJson | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…` : value
  }
  return undefined
}

function snapshotValue(
  value: unknown,
  depth: number,
  limits: SnapshotLimits,
  context: Context,
): TraceJson | undefined {
  const scalar = scalarValue(value, limits.maxStringLength)
  if (scalar !== undefined) return scalar
  if (typeof value !== 'object' || value === null) return undefined
  if (depth > limits.maxDepth) {
    context.mark()
    return '[depth-limit]'
  }
  if (Array.isArray(value)) {
    const entries: TraceJson[] = []
    for (const item of value.slice(0, limits.maxVars)) {
      if (context.exhausted) {
        entries.push('[budget-limit]')
        break
      }
      const child = snapshotValue(item, depth + 1, limits, context)
      const encoded = child === undefined ? '[unsupported]' : child
      entries.push(encoded)
      context.count(encoded)
    }
    if (value.length > limits.maxVars) {
      context.mark()
      entries.push('[truncated]')
    }
    return entries
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TS cannot index the object union without a record cast after the object checks above
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).slice(0, limits.maxVars)
  const out: Record<string, TraceJson> = {}
  for (const key of keys) {
    if (context.exhausted) break
    if (isSensitiveKey(key)) {
      const marker: TraceJson = '[redacted]'
      out[key] = marker
      context.count(marker)
      continue
    }
    const child = snapshotValue(object[key], depth + 1, limits, context)
    const encoded = child === undefined ? '[unsupported]' : child
    out[key] = encoded
    context.count(encoded)
  }
  if (Object.keys(object).length > keys.length) context.mark()
  return out
}

/**
 * Snapshot a locals record with redaction and strict bounds. Sensitive keys
 * are withheld; deep, large, or unsupported values are truncated and marked.
 */
export function snapshotLocals(
  raw: Readonly<Record<string, unknown>> | undefined,
  limits: SnapshotLimits = DEFAULT_LIMITS,
): SnapshotResult {
  if (raw === undefined || Object.keys(raw).length === 0) {
    return { locals: undefined, redacted: [], truncated: false }
  }
  const redacted = Object.keys(raw).filter(isSensitiveKey)
  const context = new Context(limits)
  const locals = snapshotValue(raw, 1, limits, context)
  const truncated = context.exhausted
  return { locals, redacted, truncated }
}
