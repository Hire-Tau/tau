import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { agents, executions, operationsExecutionAnalyses, squads } from '../../db/schema'
import {
  OPERATIONS_ANALYST_BACKFILL_WINDOW_MS,
  OPERATIONS_ANALYST_BATCH_SIZE,
  OPERATIONS_ANALYST_RESCAN_OVERLAP_MS,
  loadPendingOperationsAnalyses,
  operationsAnalystScanFloor,
  resetOperationsAnalystScanFloor,
  runOperationsAnalysisSweepOnce,
} from './scheduler'

let squadId: string | undefined
beforeEach(() => {
  resetOperationsAnalystScanFloor()
})
afterEach(async () => {
  resetOperationsAnalystScanFloor()
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  squadId = undefined
})

describe('operations analyst backfill query', () => {
  // Drives the REAL query against Postgres rather than the injected
  // `loadPending` seam every other test in this file uses: with only the seam
  // covered, deleting the `startedAt` floor or the anti-join outright left the
  // whole suite green (verified by mutation).
  test('returns only completed, recent, not-yet-analysed executions, oldest first', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `ops-backfill-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadId = squad.id
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()

    // Well inside the window but older than anything else the suite creates, so
    // the eligible rows sort to the front of the ascending batch deterministically.
    const day = 24 * 60 * 60_000
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day)
    const [oldestEligible, newerEligible, tooOld, alreadyAnalysed, notCompleted] = await db
      .insert(executions)
      .values([
        { agentId: agent.id, status: 'completed' as const, startedAt: at(29), endedAt: new Date() },
        { agentId: agent.id, status: 'completed' as const, startedAt: at(28), endedAt: new Date() },
        {
          agentId: agent.id,
          status: 'completed' as const,
          startedAt: new Date(Date.now() - OPERATIONS_ANALYST_BACKFILL_WINDOW_MS - 60_000),
          endedAt: new Date(),
        },
        { agentId: agent.id, status: 'completed' as const, startedAt: at(27), endedAt: new Date() },
        { agentId: agent.id, status: 'running' as const, startedAt: at(26) },
      ])
      .returning()
    await db.insert(operationsExecutionAnalyses).values({
      executionId: alreadyAnalysed.id,
      squadId: squad.id,
      algorithmVersion: 'ops-heuristics-v1',
      redactionVersion: 'ops-redaction-v1',
      result: 'analyzed',
    })

    const ids = await loadPendingOperationsAnalyses()

    expect(ids.length).toBeLessThanOrEqual(OPERATIONS_ANALYST_BATCH_SIZE)
    // Positive assertions first: without these the "not.toContain" checks below
    // would all pass against an empty result.
    expect(ids).toContain(oldestEligible.id)
    expect(ids).toContain(newerEligible.id)
    expect(ids.indexOf(oldestEligible.id)).toBeLessThan(ids.indexOf(newerEligible.id))
    expect(ids).not.toContain(tooOld.id)
    expect(ids).not.toContain(alreadyAnalysed.id)
    expect(ids).not.toContain(notCompleted.id)
  })
})

describe('operations analyst scheduler', () => {
  test('bounds each batch and isolates one execution failure', async () => {
    const analyze = mock(async (id: string) => {
      if (id === 'e-3') throw new Error('transient')
      return 'analyzed' as const
    })
    const ids = Array.from({ length: 30 }, (_, i) => `e-${i}`)
    const count = await runOperationsAnalysisSweepOnce({ loadPending: async () => ids, analyze, logFailure: () => {} })
    expect(analyze).toHaveBeenCalledTimes(25)
    expect(analyze.mock.calls.map((call) => call[0])).toContain('e-24')
    expect(count).toBe(24)
  })
})

describe('operations analyst scan cursor', () => {
  // Before the cursor the 30-day anti-join ran on every 60s tick even with an
  // empty backlog. These tests pin both halves: the window narrows once a sweep
  // proves the backlog is drained, and it does NOT narrow while anything the
  // sweep enumerated is still unanalysed.
  test('stops re-scanning the whole retention window once a sweep drains the backlog', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `ops-cursor-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    squadId = squad.id
    const [agent] = await db.insert(agents).values({ squadId: squad.id, agentTypeId: 'engineer' }).returning()
    const [oldPending] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'completed' as const,
        startedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000),
        endedAt: new Date(),
      })
      .returning()

    expect(await loadPendingOperationsAnalyses()).toContain(oldPending.id)

    await runOperationsAnalysisSweepOnce({ loadPending: async () => [], analyze: async () => 'analyzed' })

    // Same row, still unanalysed — it is now simply outside the scan window.
    expect(await loadPendingOperationsAnalyses()).not.toContain(oldPending.id)
  })

  test('holds the window open while a backlog remains or an analysis fails', async () => {
    const now = new Date('2026-09-01T12:00:00.000Z')
    const retentionFloor = now.getTime() - OPERATIONS_ANALYST_BACKFILL_WINDOW_MS
    const full = Array.from({ length: OPERATIONS_ANALYST_BATCH_SIZE }, (_, index) => `e-${index}`)

    await runOperationsAnalysisSweepOnce({
      now,
      loadPending: async () => full,
      analyze: async () => 'analyzed',
    })
    expect(operationsAnalystScanFloor(now).getTime()).toBe(retentionFloor)

    await runOperationsAnalysisSweepOnce({
      now,
      loadPending: async () => ['e-failing'],
      analyze: async () => {
        throw new Error('transient')
      },
      logFailure: () => {},
    })
    expect(operationsAnalystScanFloor(now).getTime()).toBe(retentionFloor)

    await runOperationsAnalysisSweepOnce({ now, loadPending: async () => ['e-ok'], analyze: async () => 'analyzed' })
    expect(operationsAnalystScanFloor(now).getTime()).toBe(now.getTime() - OPERATIONS_ANALYST_RESCAN_OVERLAP_MS)
  })
})
