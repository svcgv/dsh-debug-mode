import { describe, expect, it } from 'vitest'
import { TraceStore, type TraceStoreLimits } from '../../../src/listener/store.ts'

function event(overrides: Partial<Parameters<TraceStore['append']>[0]> = {}) {
  return { kind: 'probe' as const, runId: 'r1', ts: 1, text: 'x', ...overrides }
}

describe('TraceStore', () => {
  it('assigns monotonic sequences and reads pages with cursors', () => {
    const store = new TraceStore()
    expect(store.append(event())).toBe(0)
    expect(store.append(event({ text: 'y' }))).toBe(1)
    const page = store.read(-1, 1)
    expect(page.events.map((entry) => entry.text)).toEqual(['x'])
    expect(page.nextCursor).toBe(0)
    expect(page.hasMore).toBe(true)
    const next = store.read(page.nextCursor)
    expect(next.events.map((entry) => entry.text)).toEqual(['y'])
    expect(next.hasMore).toBe(false)
    expect(store.read(5).events).toEqual([])
  })

  it('drops oversized events and evicts oldest at the event cap', () => {
    const limits: TraceStoreLimits = { maxEvents: 2, maxBytes: 1_000_000 }
    const store = new TraceStore(limits)
    expect(store.append(event())).toBe(0)
    expect(store.append(event())).toBe(1)
    expect(store.append(event())).toBe(2)
    expect(store.count).toBe(2)
    expect(store.droppedCount).toBe(1)
    const tiny = new TraceStore({ maxEvents: 100, maxBytes: 40 })
    expect(tiny.append({ kind: 'probe', runId: 'r', ts: 1, text: 'z'.repeat(200) })).toBeNull()
    expect(tiny.droppedCount).toBe(1)
  })

  it('drops when total bytes would exceed the cap', () => {
    const store = new TraceStore({ maxEvents: 100, maxBytes: 100 })
    expect(store.append({ kind: 'probe', runId: 'r', ts: 1, text: 'x'.repeat(30) })).toBe(0)
    expect(store.append({ kind: 'probe', runId: 'r', ts: 1, text: 'y'.repeat(30) })).toBeNull()
    expect(store.droppedCount).toBe(1)
    expect(store.count).toBe(1)
  })

  it('waits for events and times out without events', async () => {
    const store = new TraceStore()
    const pending = store.waitFor(0, 50)
    const appended = store.append(event())
    expect(appended).toBe(0)
    await expect(pending).resolves.toBe(true)
    const secondWaiter = store.waitFor(1, 50)
    store.append(event())
    await expect(secondWaiter).resolves.toBe(true)
    await expect(store.waitFor(-1, 50)).resolves.toBe(true)
    const missed = store.waitFor(9, 50)
    store.append(event())
    await expect(missed).resolves.toBe(false)
    await expect(store.waitFor(3, 0)).resolves.toBe(false)
    await expect(store.waitFor(5, 20)).resolves.toBe(false)
  })
})
