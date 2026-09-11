import { describe, it, expect, mock } from 'bun:test'
import { PrecompactionController, type PrecompactionDeps } from './controller'
import { createPrecompactionExtension } from './extension'
import type { CompactionResult, SessionBeforeCompactEvent, SessionEntry } from '@earendil-works/pi-coding-agent'

function entry(id: string): SessionEntry {
  return { id, type: 'message' } as unknown as SessionEntry
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

interface Harness {
  controller: PrecompactionController
  handler: (event: SessionBeforeCompactEvent) => Promise<unknown>
  bake: ReturnType<typeof mock>
  branch: SessionEntry[]
}

/**
 * Wire a real PrecompactionController together with the real extension
 * handler, against a fake pi session expressed as PrecompactionDeps.
 */
function harness(opts: {
  tokens: number
  inFlightMarginTokens?: number
  bake?: () => Promise<CompactionResult | null>
}): Harness {
  const branch = [entry('a'), entry('b'), entry('keep')]
  const result: CompactionResult = { summary: 'BAKED', firstKeptEntryId: 'keep', tokensBefore: 1000 }
  const bake = mock(opts.bake ?? (async (): Promise<CompactionResult> => result))
  const deps: PrecompactionDeps = {
    getContextUsage: () => ({ tokens: opts.tokens, contextWindow: 200_000 }),
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
    isCompacting: () => false,
    snapshot: () => ({ entries: branch, latestCompactionEntryId: null }),
    getModelKey: () => 'anthropic/claude-sonnet-4-6/200000',
    bake,
    marginTokens: 24_576,
    inFlightMarginTokens: opts.inFlightMarginTokens ?? 8192,
  }
  const controller = new PrecompactionController(deps)
  const ext = createPrecompactionExtension(() => controller)
  const handlers = ext.handlers.get('session_before_compact')!
  const handler = handlers[0] as (event: SessionBeforeCompactEvent) => Promise<unknown>
  return { controller, handler, bake, branch }
}

const compactEvent = (entries: SessionEntry[]) =>
  ({
    type: 'session_before_compact',
    preparation: {},
    branchEntries: entries,
    signal: new AbortController().signal,
  }) as unknown as SessionBeforeCompactEvent

describe('pre-compaction integration', () => {
  it('bakes early and applies the cached result instantly at pi threshold (no second bake)', async () => {
    // 160k tokens: above the early threshold (200k - 16k - 24k = 159040),
    // below pi's own threshold (200k - 16k = 184k).
    const { controller, handler, bake, branch } = harness({ tokens: 160_000 })
    controller.onSettled()
    await flush()
    expect(bake).toHaveBeenCalledTimes(1)

    const res = (await handler(compactEvent(branch))) as { compaction: CompactionResult }
    expect(res.compaction.summary).toBe('BAKED')
    // The cached result was applied — no re-bake at apply time.
    expect(bake).toHaveBeenCalledTimes(1)
  })

  it('falls back (handler returns undefined) when the cache is invalidated', async () => {
    const { controller, handler, bake } = harness({ tokens: 160_000 })
    controller.onSettled()
    await flush()
    expect(bake).toHaveBeenCalledTimes(1)

    // Branch no longer contains firstKeptEntryId → stale → undefined.
    // Pi would then compact synchronously.
    const res = await handler(compactEvent([entry('x'), entry('y')]))
    expect(res).toBeUndefined()
  })

  it('never bakes below the early threshold', async () => {
    const { controller, bake } = harness({ tokens: 100_000 })
    controller.onSettled()
    await flush()
    expect(bake).not.toHaveBeenCalled()
  })

  it('mid-turn context growth triggers a bake that is awaited and consumed at compaction time', async () => {
    let resolveBake!: (v: CompactionResult | null) => void
    const { controller, handler, bake, branch } = harness({
      tokens: 180_000,
      bake: () => new Promise<CompactionResult | null>((resolve) => (resolveBake = resolve)),
    })

    controller.onContextGrowth()
    expect(bake).toHaveBeenCalledTimes(1)

    const resultPromise = handler(compactEvent(branch)) as Promise<{ compaction: CompactionResult } | undefined>
    resolveBake({ summary: 'BAKED', firstKeptEntryId: 'keep', tokensBefore: 1000 })
    const res = await resultPromise

    expect(res?.compaction.summary).toBe('BAKED')
  })

  it('falls back to synchronous compaction when mid-turn precompaction is disabled', async () => {
    const { controller, handler, bake, branch } = harness({ tokens: 195_000, inFlightMarginTokens: 0 })

    controller.onContextGrowth()
    await flush()
    const res = await handler(compactEvent(branch))

    expect(bake).not.toHaveBeenCalled()
    expect(res).toBeUndefined()
  })
})
