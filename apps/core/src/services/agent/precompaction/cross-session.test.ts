// apps/core/src/services/agent/precompaction/cross-session.test.ts
import { describe, it, expect, beforeEach, mock } from 'bun:test'
import {
  bindPrecompactionController,
  getPrecompactionController,
  disposePrecompactionController,
  __resetPrecompactionRegistryForTests,
} from './registry'
import type { PrecompactionDeps } from './controller'
import type { CompactionResult, SessionBeforeCompactEvent, SessionEntry } from '@earendil-works/pi-coding-agent'

const e = (id: string): SessionEntry => ({ id, type: 'message' }) as unknown as SessionEntry
const branch = [e('a'), e('b'), e('keep')]
const compactEvent = (entries: SessionEntry[]) =>
  ({
    type: 'session_before_compact',
    branchEntries: entries,
    signal: new AbortController().signal,
  }) as unknown as SessionBeforeCompactEvent

function deps(bakeImpl?: PrecompactionDeps['bake']): PrecompactionDeps {
  const result: CompactionResult = { summary: 'BAKED', firstKeptEntryId: 'keep', tokensBefore: 1000 }
  return {
    getContextUsage: () => ({ tokens: 160_000, contextWindow: 200_000 }),
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
    isCompacting: () => false,
    snapshot: () => ({ entries: branch, latestCompactionEntryId: null }),
    getModelKey: () => 'anthropic/claude-sonnet-4-6/200000',
    bake: bakeImpl ?? mock(async () => result),
    marginTokens: 24_576,
    inFlightMarginTokens: 8192,
  }
}

// Two microtask yields = the mock bake's await depth (async bake resolves in 1 hop; the controller's .then runs in the 2nd). Add a yield if the bake gains async layers.
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => __resetPrecompactionRegistryForTests())

describe('cross-session precompaction', () => {
  it('a bake started in session A is consumed by session B (the fix)', async () => {
    // Session A: bind, settle → start bake.
    const a = bindPrecompactionController('agent-1', deps())!
    a.onSettled()
    // Session A "tears down" — under the new design nothing disposes the controller.
    // (No disposePrecompactionController call here; removeSession only unsubscribes.)
    await flush()
    expect(getPrecompactionController('agent-1')).toBe(a) // survived teardown

    // Session B: rebind (same controller), then pi asks to compact.
    const b = bindPrecompactionController('agent-1', deps())!
    expect(b).toBe(a)
    const result = b.getReadyResult(compactEvent([e('a'), e('b'), e('keep'), e('new1')]))
    expect(result?.summary).toBe('BAKED')
  })

  it('regression: a surviving in-flight bake is NOT aborted by teardown', async () => {
    let resolveBake!: (v: CompactionResult | null) => void
    const c = bindPrecompactionController(
      'agent-1',
      deps(() => new Promise((r) => (resolveBake = r)))
    )!
    const events: string[] = []
    c.onLifecycle = (ev) => events.push(ev.kind)
    c.onSettled() // started, in flight
    // Simulate end-of-turn: under the new design, removeSession does NOT dispose
    // the controller, so no abort happens. Resolve the bake afterwards.
    resolveBake({ summary: 'BAKED', firstKeptEntryId: 'keep', tokensBefore: 1 })
    await flush()
    expect(events).toEqual(['started', 'succeeded']) // no 'aborted'
  })

  it('rejects (sync fallback) when the prefix diverged across sessions', async () => {
    const c = bindPrecompactionController('agent-1', deps())!
    c.onSettled()
    await flush()
    // Session B's branch kept the cut id but changed an earlier entry.
    const result = c.getReadyResult(compactEvent([e('a'), e('b2'), e('keep')]))
    expect(result).toBeUndefined()
  })

  it('explicit eviction (reset/delete/terminate) drops the controller', async () => {
    const c = bindPrecompactionController('agent-1', deps())!
    c.onSettled()
    await flush()
    disposePrecompactionController('agent-1')
    expect(getPrecompactionController('agent-1')).toBeUndefined()
  })
})
