import { describe, it, expect, beforeEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryAccessAudit, squads } from '../../../db/schema'
import { SquadMemoryGrant } from '../../../entities/SquadMemoryGrant'
import { SearchService } from '../SearchService'
import { IndexingService } from '../indexer/IndexingService'
import { LiveRateLimiter } from './live-rate-limiter'
import { FakeLiveSource } from './__fixtures__/FakeLiveSource'

async function createSquad(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(squads).values({ id, name, purpose: 'live memory adapter test', status: 'active' })
  return id
}

describe('LiveMemorySourceAdapter SearchService integration', () => {
  beforeEach(() => {
    IndexingService._reset()
  })

  it('fans out to live adapters and merges with indexed results', async () => {
    const squadId = await createSquad('live fanout')
    const adapter = new FakeLiveSource({
      results: [
        {
          sourceSquadId: squadId,
          sourceType: 'fake_live',
          sourceId: 'msg-1',
          title: 'Live hit',
          snippet: 'live adapter result',
          score: 0.95,
          sensitivity: 'internal',
          provenance: { url: 'https://example.test/msg-1' },
        },
      ],
    })
    const indexingService = IndexingService.instance()
    indexingService.registerLiveAdapter(adapter)
    await indexingService.indexFile({
      squadId,
      path: '/memory/live-fanout.md',
      content: `---
title: Indexed adapter result
---

# Indexed adapter result

This indexed adapter result should merge with the live adapter result.`,
    })

    const results = await new SearchService({ liveRateLimiter: new LiveRateLimiter() }).search(squadId, 'adapter', {
      limit: 5,
    })

    expect(adapter.calls).toHaveLength(1)
    expect(results).toContainEqual(
      expect.objectContaining({
        sourceType: 'fake_live',
        snippet: 'live adapter result',
        provenance: { url: 'https://example.test/msg-1' },
      })
    )
    expect(results).toContainEqual(
      expect.objectContaining({
        sourceType: 'memory_file',
        path: '/memory/live-fanout.md',
      })
    )
  })

  it('records timeout degradation in provenance without failing search', async () => {
    const squadId = await createSquad('live timeout')
    IndexingService.instance().registerLiveAdapter(new FakeLiveSource({ timeoutMs: 5, delayMs: 50 }))

    const results = await new SearchService({ liveRateLimiter: new LiveRateLimiter() }).search(squadId, 'slow', {
      sourceTypes: ['fake_live'],
    })

    expect(results).toContainEqual(
      expect.objectContaining({ sourceType: 'fake_live', provenance: { error: 'timeout' } })
    )
  })

  it('records rate-limit degradation without calling the adapter', async () => {
    const squadId = await createSquad('live ratelimit')
    const adapter = new FakeLiveSource({ perMinute: 0 })
    IndexingService.instance().registerLiveAdapter(adapter)

    const results = await new SearchService({ liveRateLimiter: new LiveRateLimiter() }).search(squadId, 'limited', {
      sourceTypes: ['fake_live'],
    })

    expect(adapter.calls).toHaveLength(0)
    expect(results).toContainEqual(
      expect.objectContaining({ sourceType: 'fake_live', provenance: { error: 'rate_limited' } })
    )
  })

  it('respects sourceTypes selection and does not call unselected live adapters', async () => {
    const squadId = await createSquad('live source filters')
    const selected = new FakeLiveSource({ sourceType: 'selected_live' })
    const skipped = new FakeLiveSource({ sourceType: 'skipped_live' })
    const registry = IndexingService.instance()
    registry.registerLiveAdapter(selected)
    registry.registerLiveAdapter(skipped)

    await new SearchService({ liveRateLimiter: new LiveRateLimiter() }).search(squadId, 'filter', {
      sourceTypes: ['selected_live'],
    })

    expect(selected.calls).toHaveLength(1)
    expect(skipped.calls).toHaveLength(0)
  })

  it('audits live calls', async () => {
    const callerSquadId = await createSquad('live audit caller')
    const sourceSquadId = await createSquad('live audit source')
    IndexingService.instance().registerLiveAdapter(new FakeLiveSource({ sourceType: 'audit_live' }))
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['audit_live'], sensitivity: 'internal' } },
    })

    await new SearchService({ liveRateLimiter: new LiveRateLimiter() }).search(callerSquadId, 'audit', {
      sourceTypes: ['audit_live'],
      sourceSquadIds: [sourceSquadId],
    })

    const rows = await db.select().from(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    expect(rows).toContainEqual(
      expect.objectContaining({ sourceSquadId, action: 'live_search:audit_live', resultCount: 0 })
    )
  })
})
