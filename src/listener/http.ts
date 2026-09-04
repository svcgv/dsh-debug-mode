/**
 * HTTP ingestion endpoint for the in-app probe runtime. The endpoint is
 * intentionally narrow: one POST path, JSON body bounded by size and shape,
 * token-authenticated batches, and a JSON ack the client can rely on.
 *
 * @module dsh-debug-mode/listener/http
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TraceStore } from './store.ts'
import type { TraceEvent } from './types.ts'

/** Handler options. */
export interface IngestHandlerOptions {
  readonly store: TraceStore
  /** High-entropy per-run token. */
  readonly token: string
  /** Maximum accepted request body bytes. */
  readonly maxBodyBytes?: number
  /** Maximum events per batch. */
  readonly maxBatch?: number
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024
const DEFAULT_MAX_BATCH = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tokensEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

/**
 * Build a request handler that ingests one authenticated batch per request.
 * @returns a Node http request listener.
 */
export function createIngestHandler(
  options: IngestHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH
  return (req, res) => {
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (req.url === undefined || new URL(req.url, 'http://localhost').pathname !== '/ingest') {
      send(res, 404, { ok: false, error: 'not-found' })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      size += chunk.length
      if (size > maxBodyBytes) {
        // Drop further bytes instead of buffering them; the final ack below
        // still tells the client the payload was rejected.
        rejected = true
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) {
        send(res, 413, { ok: false, error: 'payload-too-large' })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        send(res, 400, { ok: false, error: 'invalid-json' })
        return
      }
      if (
        !isRecord(parsed) ||
        typeof parsed.token !== 'string' ||
        !tokensEqual(options.token, parsed.token)
      ) {
        send(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      if (
        !Array.isArray(parsed.events) ||
        parsed.events.length === 0 ||
        parsed.events.length > maxBatch
      ) {
        send(res, 400, { ok: false, error: 'invalid-batch' })
        return
      }
      let accepted = 0
      let dropped = 0
      for (const entry of parsed.events) {
        const normalized = normalizeEvent(entry)
        if (normalized === undefined) {
          dropped += 1
          continue
        }
        const seq = options.store.append(normalized)
        if (seq === null) dropped += 1
        else accepted += 1
      }
      send(res, 200, { ok: true, accepted, dropped })
    })
  }
}

/** Validate and normalize one raw event shape. */
function normalizeEvent(value: unknown): Omit<TraceEvent, 'seq'> | undefined {
  if (!isRecord(value)) return undefined
  const kind = value.kind
  const runId = value.runId
  if (
    (kind !== 'probe' && kind !== 'heartbeat' && kind !== 'exception') ||
    typeof runId !== 'string'
  ) {
    return undefined
  }
  const ts = value.ts
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) return undefined
  const locals = isJsonValue(value.locals) ? value.locals : undefined
  return {
    kind,
    runId,
    ts,
    ...(typeof value.file === 'string' ? { file: value.file } : {}),
    ...(typeof value.line === 'number' && Number.isSafeInteger(value.line)
      ? { line: value.line }
      : {}),
    ...(typeof value.functionName === 'string' ? { functionName: value.functionName } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(locals === undefined ? {} : { locals }),
  }
}

/** Whether a value is lossless JSON within a bounded depth. */
function isJsonValue(value: unknown, depth = 0): value is TraceEvent['locals'] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth > 20) return false
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1))
  if (typeof value === 'object') {
    return Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  }
  return false
}
