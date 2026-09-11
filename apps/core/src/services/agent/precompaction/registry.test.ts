// apps/core/src/services/agent/precompaction/registry.test.ts
import { describe, it, expect, beforeEach, mock } from 'bun:test'
import {
  bindPrecompactionController,
  getPrecompactionController,
  disposePrecompactionController,
  disposeAllPrecompactionControllers,
  setPrecompactionLifecycleSink,
  getPrecompactionMetrics,
  __resetPrecompactionRegistryForTests,
  MAX_PRECOMPACTION_CONTROLLERS,
} from './registry'
import type { PrecompactionDeps } from './controller'
import type { CompactionResult } from '@earendil-works/pi-coding-agent'

function deps(over: Partial<PrecompactionDeps> = {}): PrecompactionDeps {
  const result: CompactionResult = { summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 1 }
  return {
    getContextUsage: () => ({ tokens: 160_000, contextWindow: 200_000 }),
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
    isCompacting: () => false,
    snapshot: () => ({ entries: [], latestCompactionEntryId: null }),
    getModelKey: () => 'm',
    bake: mock(async () => result),
    marginTokens: 24_576,
    inFlightMarginTokens: 8192,
    ...over,
  }
}

beforeEach(() => __resetPrecompactionRegistryForTests())

describe('precompaction registry', () => {
  it('get-or-create returns the same controller and rebinds', () => {
    const a = bindPrecompactionController('agent-1', deps())
    const b = bindPrecompactionController('agent-1', deps())
    expect(a).toBe(b)
    expect(getPrecompactionController('agent-1')).toBe(a)
  })

  it('dispose removes the map entry; a later bind constructs fresh', () => {
    const a = bindPrecompactionController('agent-1', deps())
    disposePrecompactionController('agent-1')
    expect(getPrecompactionController('agent-1')).toBeUndefined()
    const b = bindPrecompactionController('agent-1', deps())
    expect(b).not.toBe(a)
  })

  it('routes lifecycle events to the injected sink and tallies metrics', async () => {
    const seen: string[] = []
    setPrecompactionLifecycleSink((agentId, event) => seen.push(`${agentId}:${event.kind}`))
    const c = bindPrecompactionController('agent-1', deps())!
    c.onSettled()
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toContain('agent-1:started')
    expect(getPrecompactionMetrics().started).toBeGreaterThanOrEqual(1)
  })

  it('evicts the least-recently-active controller past the cap', () => {
    for (let i = 0; i < MAX_PRECOMPACTION_CONTROLLERS + 1; i++) {
      bindPrecompactionController(`agent-${i}`, deps())
    }
    // The first-bound (oldest activity) controller was evicted.
    expect(getPrecompactionController('agent-0')).toBeUndefined()
    expect(getPrecompactionController(`agent-${MAX_PRECOMPACTION_CONTROLLERS}`)).toBeDefined()
  })

  it('disposeAll clears everything', () => {
    bindPrecompactionController('agent-1', deps())
    bindPrecompactionController('agent-2', deps())
    disposeAllPrecompactionControllers()
    expect(getPrecompactionController('agent-1')).toBeUndefined()
    expect(getPrecompactionController('agent-2')).toBeUndefined()
  })
})
