import { afterEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { agents, db, setDatabaseQueryObserverForTest, slotClaims, slotPools, slotWaiters, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { listSlotHistory } from './history'
import {
  claimSlot,
  getPool,
  listPools,
  registerPool,
  releaseSlot,
  renewSlot,
  subscribeSlot,
  unregisterPool,
  unsubscribeSlot,
  updatePool,
} from './store'

const squadIds: string[] = []
const agentIds: string[] = []

async function createSquad(): Promise<Squad> {
  const squad = await Squad.create({ name: `slot-history-${crypto.randomUUID().slice(0, 8)}`, purpose: 'tests' })
  squadIds.push(squad.id)
  return squad
}

async function createAgent(squadId: string): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({ agentTypeId: 'slot-history-test', squadId, status: 'idle' })
    .returning()
  agentIds.push(agent!.id)
  return agent!.id
}

afterEach(async () => {
  setDatabaseQueryObserverForTest(undefined)
  if (squadIds.length === 0) return
  const poolIds = (
    await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))
  ).map(({ id }) => id)
  if (poolIds.length > 0) {
    await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
    await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
    await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
  }
  if (agentIds.length > 0) await db.delete(agents).where(inArray(agents.id, agentIds))
  await db.delete(squads).where(inArray(squads.id, squadIds))
  squadIds.length = 0
  agentIds.length = 0
})

interface ExpectedHistoryRow {
  kind: 'claim' | 'waiter'
  id: string
  endedAt: Date | null
}

async function insertTerminalRows(
  poolId: string,
  ownerAgentId: string,
  endedAt: Date | null,
  count: number
): Promise<ExpectedHistoryRow[]> {
  const claims = await db
    .insert(slotClaims)
    .values(
      Array.from({ length: count }, () => ({
        poolId,
        ownerAgentId,
        status: 'released' as const,
        expiresAt: endedAt ?? new Date(0),
        endedAt,
        terminalReason: 'released',
      }))
    )
    .returning({ id: slotClaims.id, endedAt: slotClaims.endedAt })
  const waiters = await db
    .insert(slotWaiters)
    .values(
      Array.from({ length: count }, () => ({
        poolId,
        ownerAgentId,
        status: 'canceled' as const,
        endedAt,
        terminalReason: 'canceled',
      }))
    )
    .returning({ id: slotWaiters.id, endedAt: slotWaiters.endedAt })
  return [
    ...claims.map((row) => ({ kind: 'claim' as const, ...row })),
    ...waiters.map((row) => ({ kind: 'waiter' as const, ...row })),
  ]
}

describe('slot terminal history', () => {
  test('uses strict tied-timestamp keyset pagination without duplicates', async () => {
    const squad = await createSquad()
    const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const owner = await createAgent(squad.id)
    const expectedRows = [
      ...(await insertTerminalRows(pool.id, owner, new Date('2026-09-05T08:00:00.000Z'), 3)),
      ...(await insertTerminalRows(pool.id, owner, new Date('2026-09-05T07:00:00.000Z'), 1)),
      ...(await insertTerminalRows(pool.id, owner, null, 1)),
    ].sort((left, right) => {
      const leftTime = left.endedAt?.getTime() ?? Number.NEGATIVE_INFINITY
      const rightTime = right.endedAt?.getTime() ?? Number.NEGATIVE_INFINITY
      if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1
      if (left.kind !== right.kind) return left.kind === 'claim' ? -1 : 1
      return left.id === right.id ? 0 : left.id < right.id ? 1 : -1
    })

    const traversed: Awaited<ReturnType<typeof listSlotHistory>>['items'] = []
    let cursor: string | undefined
    do {
      const page = await listSlotHistory(squad.id, 'tests', { diagnostics: true }, { limit: 2, cursor })
      traversed.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(traversed.map(({ kind, id }) => `${kind}:${id}`)).toEqual(
      expectedRows.map(({ kind, id }) => `${kind}:${id}`)
    )

    const first = await listSlotHistory(squad.id, 'tests', { diagnostics: true }, { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBeString()

    const second = await listSlotHistory(
      squad.id,
      'tests',
      { diagnostics: true },
      { limit: 2, cursor: first.nextCursor! }
    )
    expect(new Set([...first.items, ...second.items].map((item) => `${item.kind}:${item.id}`)).size).toBe(4)

    await insertTerminalRows(pool.id, owner, new Date('2026-09-05T09:00:00.000Z'), 1)
    const continued = await listSlotHistory(
      squad.id,
      'tests',
      { diagnostics: true },
      { limit: 2, cursor: first.nextCursor! }
    )
    expect(continued.items).toEqual(second.items)
    expect((await listSlotHistory(squad.id, 'tests', { diagnostics: true }, { limit: 1 })).items[0]!.endedAt).toEqual(
      new Date('2026-09-05T09:00:00.000Z')
    )
  })

  test('filters owners in SQL before the page limit and supports diagnostics', async () => {
    const squad = await createSquad()
    const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const own = await createAgent(squad.id)
    const foreign = await createAgent(squad.id)
    await insertTerminalRows(pool.id, own, new Date('2026-09-05T07:00:00.000Z'), 3)
    await insertTerminalRows(pool.id, foreign, new Date('2026-09-05T08:00:00.000Z'), 4)

    const ordinary = await listSlotHistory(squad.id, 'tests', { agentId: own, diagnostics: false }, { limit: 3 })
    expect(ordinary.items).toHaveLength(3)
    expect(ordinary.items.every((item) => item.ownerAgentId === own)).toBe(true)

    const diagnostics = await listSlotHistory(squad.id, 'tests', { diagnostics: true }, { limit: 100 })
    expect(new Set(diagnostics.items.map((item) => item.ownerAgentId))).toEqual(new Set([own, foreign]))
    expect(await listSlotHistory(squad.id, 'tests', { diagnostics: false })).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    })
  })

  test('validates bounded limits and binds cursors to pool and visibility', async () => {
    const squad = await createSquad()
    const firstPool = await registerPool({ squadId: squad.id, key: 'first', createdBy: 'test' })
    await registerPool({ squadId: squad.id, key: 'second', createdBy: 'test' })
    const owner = await createAgent(squad.id)
    const other = await createAgent(squad.id)
    await insertTerminalRows(firstPool.id, owner, new Date(), 2)
    const page = await listSlotHistory(squad.id, 'first', { agentId: owner, diagnostics: false }, { limit: 1 })

    for (const limit of [0, 101, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(listSlotHistory(squad.id, 'first', { diagnostics: true }, { limit })).rejects.toMatchObject({
        code: 'invalid_history_limit',
      })
    }
    await expect(listSlotHistory(squad.id, 'first', { diagnostics: true }, { limit: 50 })).resolves.toBeDefined()
    await expect(listSlotHistory(squad.id, 'first', { diagnostics: true }, { limit: 100 })).resolves.toBeDefined()
    for (const request of [
      () => listSlotHistory(squad.id, 'first', { agentId: owner, diagnostics: false }, { cursor: 'bad!' }),
      () => listSlotHistory(squad.id, 'first', { agentId: owner, diagnostics: false }, { cursor: 'a'.repeat(1001) }),
      () => listSlotHistory(squad.id, 'second', { agentId: owner, diagnostics: false }, { cursor: page.nextCursor! }),
      () => listSlotHistory(squad.id, 'first', { agentId: other, diagnostics: false }, { cursor: page.nextCursor! }),
      () => listSlotHistory(squad.id, 'first', { diagnostics: true }, { cursor: page.nextCursor! }),
    ]) {
      await expect(request()).rejects.toMatchObject({ code: 'invalid_cursor' })
    }
  })

  test('ordinary reads and mutations never issue terminal-history SELECTs', async () => {
    const squad = await createSquad()
    const holder = await createAgent(squad.id)
    const waiter = await createAgent(squad.id)
    const terminalHistoryQueries: string[] = []
    setDatabaseQueryObserverForTest((query, params) => {
      const normalized = query.toLowerCase().replaceAll(/\s+/g, ' ').trim()
      const readsSlotState = normalized.startsWith('select') || normalized.startsWith('with')
      const readsClaims = /\bfrom "?slot_claims"?\b/.test(normalized)
      const readsWaiters = /\bfrom "?slot_waiters"?\b/.test(normalized)
      const readsTerminalStatus =
        (readsClaims && (normalized.includes("status<>'active'") || params.includes('active'))) ||
        (readsWaiters && (normalized.includes("status<>'queued'") || params.includes('queued')))
      if (readsSlotState && readsTerminalStatus && normalized.includes('<>')) terminalHistoryQueries.push(query)
    })

    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const claim = await claimSlot(squad.id, 'tests', holder)
    const queued = await subscribeSlot(squad.id, 'tests', waiter)
    if (claim.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')
    await renewSlot(squad.id, 'tests', holder, claim.claim.id)
    await unsubscribeSlot(squad.id, 'tests', waiter, queued.waiter.id)
    await releaseSlot(squad.id, 'tests', holder, claim.claim.id)
    await updatePool(squad.id, 'tests', { capacity: 2 })
    await listPools(squad.id, { diagnostics: true })
    await getPool(squad.id, 'tests', { diagnostics: true })
    expect(terminalHistoryQueries).toEqual([])

    await listSlotHistory(squad.id, 'tests', { diagnostics: true })
    expect(terminalHistoryQueries).toHaveLength(1)
    await unregisterPool(squad.id, 'tests')
    expect(terminalHistoryQueries).toHaveLength(1)
  })
})
