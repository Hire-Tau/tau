import { describe, expect, it } from 'bun:test'
import { decodeCursor } from './cursor'
import type { Snapshot } from './snapshot'
import { runWatch, type RunnerDeps, type WatchResult } from './runner'

const empty = (): Snapshot => ({ v: 1, streams: {}, actions: {}, inbox: {} })
const withAction = (id: string, hash: string): Snapshot => ({
  ...empty(),
  actions: { [id]: { hash, type: 'agent-question', squadId: null, canRespond: true } },
})

interface Harness {
  deps: RunnerDeps
  results: WatchResult[]
  warnings: string[]
  hint: () => void
  socketClosed: () => boolean
  queue: Array<Snapshot | Error>
}

function harness(over: Partial<RunnerDeps> = {}, queue: Array<Snapshot | Error> = []): Harness {
  const results: WatchResult[] = []
  const warnings: string[] = []
  let onHint: () => void = () => {}
  let closed = false
  const deps: RunnerDeps = {
    fetchSnapshot: async () => {
      const next = queue.shift()
      if (next === undefined) throw new Error('queue exhausted')
      if (next instanceof Error) throw next
      return next
    },
    openSocket: (hint) => {
      onHint = hint
      return { close: () => (closed = true) }
    },
    emit: (r) => results.push(r),
    warn: (m) => warnings.push(m),
    now: () => 0,
    follow: false,
    pollMs: 60_000,
    debounceMs: 0,
    ...over,
  }
  return { deps, results, warnings, hint: () => onHint(), socketClosed: () => closed, queue }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('runWatch --once', () => {
  it('takes a baseline, waits for a hint, emits the delta, closes the socket, and resolves', async () => {
    const h = harness({}, [empty(), withAction('a-1', 'h1')])
    const done = runWatch(h.deps)
    await tick() // baseline fetched, socket open (production hints on open; here we hint manually)
    h.hint()
    await done
    expect(h.results).toHaveLength(1)
    expect(h.results[0].events.map((e) => e.kind)).toEqual(['action.pending'])
    expect(decodeCursor(h.results[0].cursor)).toEqual(withAction('a-1', 'h1'))
    expect(h.socketClosed()).toBe(true)
  })

  it('keeps waiting when a hint produces no material change', async () => {
    const h = harness({}, [empty(), empty(), withAction('a-1', 'h1')])
    const done = runWatch(h.deps)
    await tick()
    h.hint()
    await tick()
    expect(h.results).toHaveLength(0)
    h.hint()
    await done
    expect(h.results).toHaveLength(1)
  })

  it('uses --cursor as the baseline without fetching first', async () => {
    const h = harness({ initial: empty() }, [withAction('a-1', 'h1')])
    const done = runWatch(h.deps)
    await tick()
    h.hint()
    await done
    expect(h.results[0].events.map((e) => e.kind)).toEqual(['action.pending'])
  })

  it('times out with an empty result and a fresh cursor', async () => {
    const h = harness({ timeoutMs: 10 }, [empty()])
    await runWatch(h.deps)
    expect(h.results).toEqual([{ at: expect.any(String), cursor: expect.any(String), events: [] }])
    expect(h.socketClosed()).toBe(true)
  })

  it('re-snapshots on the poll timer without a socket', async () => {
    const h = harness({ openSocket: () => null, pollMs: 10 }, [empty(), withAction('a-1', 'h1')])
    await runWatch(h.deps)
    expect(h.results[0].events.map((e) => e.kind)).toEqual(['action.pending'])
  })

  it('emits health.degraded after three consecutive failures and keeps the previous snapshot', async () => {
    const boom = new Error('gh timed out')
    const h = harness({}, [empty(), boom, boom, boom])
    const done = runWatch(h.deps)
    await tick()
    h.hint()
    await tick()
    h.hint()
    await tick()
    expect(h.results).toHaveLength(0)
    h.hint()
    await done
    expect(h.results[0].events).toEqual([expect.objectContaining({ kind: 'health.degraded', error: 'gh timed out' })])
    expect(decodeCursor(h.results[0].cursor)).toEqual(empty())
  })

  it('fails fast when the baseline itself cannot be fetched', async () => {
    const h = harness({}, [new Error('401')])
    await expect(runWatch(h.deps)).rejects.toThrow('401')
  })
})

describe('runWatch --follow', () => {
  it('emits every batch, recovers health, and never resolves', async () => {
    const boom = new Error('down')
    const h = harness({ follow: true }, [empty(), withAction('a-1', 'h1'), boom, boom, boom, withAction('a-1', 'h2')])
    let resolved = false
    void runWatch(h.deps).then(() => (resolved = true))
    await tick()
    for (let i = 0; i < 5; i++) {
      h.hint()
      await tick()
    }
    expect(resolved).toBe(false)
    expect(h.results.map((r) => r.events.map((e) => e.kind))).toEqual([
      ['action.pending'],
      ['health.degraded'],
      ['health.recovered', 'action.pending'],
    ])
  })

  it('passes an idle state so idle events can fire', async () => {
    const idle: Snapshot = {
      ...empty(),
      streams: { 'ws-1': { status: 'active', derived: 'idle', active: 0, waits: {}, squadId: 'sq', title: 'T' } },
    }
    let now = 0
    const h = harness({ follow: true, now: () => now }, [idle, idle, idle])
    void runWatch(h.deps)
    await tick()
    h.hint()
    await tick()
    now = 10 * 60_000
    h.hint()
    await tick()
    expect(h.results.flatMap((r) => r.events.map((e) => e.kind))).toEqual(['workstream.idle'])
  })
})
