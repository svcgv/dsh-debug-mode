import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TraceStore, TraceStoreError, type TraceStoreLimits } from '../../../src/listener/store.ts'

function event(overrides: Partial<Parameters<TraceStore['append']>[0]> = {}) {
  return { kind: 'probe' as const, runId: 'r1', ts: 1, text: 'x', ...overrides }
}

describe('TraceStore', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-trace-store-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('assigns monotonic sequences and reads pages with cursors', async () => {
    const store = new TraceStore()
    await expect(store.append(event())).resolves.toBe(0)
    await expect(store.append(event({ text: 'y' }))).resolves.toBe(1)
    const page = store.read(-1, 1)
    expect(page.events.map((entry) => entry.text)).toEqual(['x'])
    expect(page.nextCursor).toBe(0)
    expect(page.hasMore).toBe(true)
    const next = store.read(page.nextCursor)
    expect(next.events.map((entry) => entry.text)).toEqual(['y'])
    expect(next.hasMore).toBe(false)
    expect(store.read(5).events).toEqual([])
    await store.close()
  })

  it('persists accepted events as bounded JSONL and flushes before close', async () => {
    const logPath = join(directory, 'trace.jsonl')
    const store = new TraceStore({ maxEvents: 10, maxBytes: 1_000_000 }, logPath)
    await store.initialize()
    await expect(store.append(event({ text: 'saved' }))).resolves.toBe(0)
    await store.close()

    const lines = (await readFile(logPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      seq: 0,
      kind: 'probe',
      runId: 'r1',
      text: 'saved',
    })
  })

  it('rejects duplicate logs and lifecycle misuse with stable error codes', async () => {
    const logPath = join(directory, 'duplicate.jsonl')
    await writeFile(logPath, '', 'utf8')
    const duplicate = new TraceStore({ maxEvents: 10, maxBytes: 1_000 }, logPath)
    await expect(duplicate.initialize()).rejects.toMatchObject({ code: 'TRACE_LOG_EXISTS' })

    const memoryStore = new TraceStore()
    await memoryStore.initialize()
    await memoryStore.close()

    const notReady = new TraceStore(
      { maxEvents: 10, maxBytes: 1_000 },
      join(directory, 'ready.jsonl'),
    )
    await expect(notReady.append(event())).rejects.toMatchObject({ code: 'TRACE_STORE_NOT_READY' })
    await notReady.close()
    await expect(notReady.initialize()).rejects.toMatchObject({ code: 'TRACE_STORE_CLOSED' })
    await expect(notReady.append(event())).rejects.toMatchObject({ code: 'TRACE_STORE_CLOSED' })
    await notReady.close()

    const plain = new TraceStore()
    expect(plain.pendingCount).toBe(0)
    await plain.initialize()
    await plain.close()
    await plain.close()
    expect(new TraceStoreError('TRACE_STORE_BUSY', 'busy')).toMatchObject({
      code: 'TRACE_STORE_BUSY',
      message: 'busy',
    })
  })

  it('reports a non-conflict failure while creating the persistent log', async () => {
    const store = new TraceStore(
      { maxEvents: 10, maxBytes: 1_000 },
      join(directory, 'bad\u0000path'),
    )
    await expect(store.initialize()).rejects.toMatchObject({ code: 'TRACE_PERSISTENCE_FAILED' })
  })

  it('does not append an event when the persisted byte cap is exhausted', async () => {
    const logPath = join(directory, 'trace.jsonl')
    const store = new TraceStore({ maxEvents: 100, maxBytes: 180 }, logPath)
    await store.initialize()
    await expect(store.append(event({ text: 'first' }))).resolves.toBe(0)
    await expect(store.append(event({ text: 'second'.repeat(30) }))).resolves.toBeNull()
    expect(store.droppedCount).toBe(1)
    await store.close()
    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('reports append failures and does not continue after persistence breaks', async () => {
    const logPath = join(directory, 'failure.jsonl')
    const store = new TraceStore({ maxEvents: 10, maxBytes: 1_000_000 }, logPath)
    await store.initialize()
    await rm(logPath)
    await mkdir(logPath)
    const first = store.append(event({ text: 'first' }))
    const second = store.append(event({ text: 'second' }))
    await expect(first).rejects.toMatchObject({ code: 'TRACE_PERSISTENCE_FAILED' })
    await expect(second).rejects.toMatchObject({ code: 'TRACE_PERSISTENCE_FAILED' })
    await expect(store.append(event({ text: 'after-failure' }))).rejects.toMatchObject({
      code: 'TRACE_PERSISTENCE_FAILED',
    })
    await store.close()
  })

  it('enforces the persisted line-byte cap independently of the event cap', async () => {
    const logPath = join(directory, 'line-cap.jsonl')
    const rawBytes = Buffer.byteLength(JSON.stringify(event()), 'utf8')
    const store = new TraceStore({ maxEvents: 10, maxBytes: rawBytes + 1 }, logPath)
    await store.initialize()
    await expect(store.append(event())).resolves.toBeNull()
    expect(store.droppedCount).toBe(1)
    await store.close()
  })

  it('drops oversized events and evicts oldest at the event cap', async () => {
    const limits: TraceStoreLimits = { maxEvents: 2, maxBytes: 1_000_000 }
    const store = new TraceStore(limits)
    await expect(store.append(event())).resolves.toBe(0)
    await expect(store.append(event())).resolves.toBe(1)
    await expect(store.append(event())).resolves.toBe(2)
    expect(store.count).toBe(2)
    expect(store.droppedCount).toBe(1)
    const tiny = new TraceStore({ maxEvents: 100, maxBytes: 40 })
    await expect(
      tiny.append({ kind: 'probe', runId: 'r', ts: 1, text: 'z'.repeat(200) }),
    ).resolves.toBeNull()
    expect(tiny.droppedCount).toBe(1)
    await store.close()
    await tiny.close()
  })

  it('waits for events and times out without events', async () => {
    const store = new TraceStore()
    const pending = store.waitFor(0, 50)
    const appended = store.append(event())
    await expect(appended).resolves.toBe(0)
    await expect(pending).resolves.toBe(true)
    const secondWaiter = store.waitFor(1, 50)
    await store.append(event())
    await expect(secondWaiter).resolves.toBe(true)
    await expect(store.waitFor(-1, 50)).resolves.toBe(true)
    const missed = store.waitFor(9, 50)
    await store.append(event())
    await expect(missed).resolves.toBe(false)
    await expect(store.waitFor(3, 0)).resolves.toBe(false)
    await expect(store.waitFor(5, 20)).resolves.toBe(false)
    await store.close()
  })

  it('rejects a saturated pending write queue instead of growing without bound', async () => {
    const store = new TraceStore()
    const operations = Array.from({ length: 1_001 }, () => store.append(event()))
    await expect(operations.at(-1)).rejects.toMatchObject({ code: 'TRACE_STORE_BUSY' })
    await Promise.all(operations.slice(0, -1))
    await store.close()
  })

  it('resolves pending waits when closed', async () => {
    const store = new TraceStore()
    const pending = store.waitFor(99, 1_000)
    await store.close()
    await expect(pending).resolves.toBe(false)
  })
})
