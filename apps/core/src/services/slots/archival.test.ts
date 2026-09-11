import { afterEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { agents, db, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { Agent } from '../../entities/Agent'
import { makeDormant } from '../agent/lifecycle'
import { reconcileSlotsOnce } from './reconciliation'
import {
  claimSlot,
  getPool,
  listPools,
  registerPool,
  setSlotAfterPoolLockHookForTest,
  subscribeSlot,
  retireSquadSlotStateInTransaction,
} from './store'

const squadIds: string[] = []
const agentIds: string[] = []

afterEach(async () => {
  setSlotAfterPoolLockHookForTest(undefined)
  if (squadIds.length === 0) return
  const poolIds = (
    await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))
  ).map((row) => row.id)
  if (poolIds.length > 0) {
    await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
    await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
    await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
    await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
  }
  if (agentIds.length > 0) await db.delete(agents).where(inArray(agents.id, agentIds))
  await db.delete(squads).where(inArray(squads.id, squadIds))
  squadIds.length = 0
  agentIds.length = 0
})

async function createSquad(): Promise<Squad> {
  const squad = await Squad.create({ name: `slot-archive-${crypto.randomUUID().slice(0, 8)}`, purpose: 'slot tests' })
  squadIds.push(squad.id)
  return squad
}

async function createAgent(squadId: string): Promise<Agent> {
  const [row] = await db.insert(agents).values({ agentTypeId: 'slot-archive-test', squadId }).returning()
  agentIds.push(row!.id)
  return new Agent(row!)
}

function pauseOperation(operation: string): { entered: Promise<void>; resume: () => void } {
  let enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  let resume!: () => void
  const resumed = new Promise<void>((resolve) => {
    resume = resolve
  })
  let paused = false
  setSlotAfterPoolLockHookForTest(async (current) => {
    if (current !== operation || paused) return
    paused = true
    enter()
    await resumed
  })
  return { entered, resume }
}

/** Simulate the lag window: archived_at is authoritative while slot retirement retries. */
async function markArchivedWithoutRetirement(squadId: string): Promise<void> {
  const now = new Date()
  await db.update(squads).set({ status: 'archived', archivedAt: now, updatedAt: now }).where(eq(squads.id, squadId))
}

describe('squad archival retires slot state', () => {
  test('archive retires pools atomically without promoting or notifying', async () => {
    const squad = await createSquad()
    const pool = await registerPool({ squadId: squad.id, key: 'tests', capacity: 1, createdBy: 'test' })
    const holder = await createAgent(squad.id)
    const successor = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', holder.id)
    if (granted.outcome !== 'granted') throw new Error('bad fixture')
    await subscribeSlot(squad.id, 'tests', successor.id)
    const [notification] = await db
      .insert(slotNotifications)
      .values({
        poolId: pool.id,
        claimId: granted.claim.id!,
        recipientAgentId: holder.id,
        kind: 'granted',
        idempotencyKey: `archival-grant:${granted.claim.id!}`,
        nextAttemptAt: new Date(),
      })
      .returning()

    await squad.archive()

    expect((await db.select().from(slotPools).where(eq(slotPools.id, pool.id)))[0]!.unregisteredAt).not.toBeNull()
    expect((await db.select().from(slotClaims).where(eq(slotClaims.id, granted.claim.id!)))[0]).toMatchObject({
      status: 'released',
      terminalReason: 'squad_archived',
    })
    const [waiter] = await db.select().from(slotWaiters).where(eq(slotWaiters.ownerAgentId, successor.id))
    expect(waiter).toMatchObject({ status: 'canceled', terminalReason: 'squad_archived' })
    // The stale grant settles terminally instead of delivering, and no new notification rows appear.
    expect(
      (await db.select().from(slotNotifications).where(eq(slotNotifications.id, notification!.id)))[0]
    ).toMatchObject({ status: 'delivered', lastErrorCode: 'claim_inactive' })
    expect(await db.select().from(slotNotifications).where(eq(slotNotifications.poolId, pool.id))).toHaveLength(1)
    expect(await db.select().from(slotClaims).where(eq(slotClaims.ownerAgentId, successor.id))).toHaveLength(0)
  })

  test('retirement is idempotent and re-archiving keeps state retired', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const holder = await createAgent(squad.id)
    await claimSlot(squad.id, 'tests', holder.id)

    await squad.archive()
    const summary = await db.transaction((tx) => retireSquadSlotStateInTransaction(tx, squad.id, new Date()))
    expect(summary).toEqual({ poolsRetired: 0, claimsReleased: 0, waitersCanceled: 0 })
    await squad.archive()

    const [pool] = await db.select().from(slotPools).where(eq(slotPools.squadId, squad.id))
    expect(pool!.unregisteredAt).not.toBeNull()
    expect((await db.select().from(slotClaims).where(eq(slotClaims.ownerAgentId, holder.id)))[0]).toMatchObject({
      status: 'released',
      terminalReason: 'squad_archived',
    })
  })

  test('a claim that wins the archive race is retired when archive commits', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const claimer = await createAgent(squad.id)

    const pause = pauseOperation('claim')
    const claiming = claimSlot(squad.id, 'tests', claimer.id)
    await pause.entered
    // Archive blocks on the pool lock the claim holds; both must still converge.
    const archiving = squad.archive()
    pause.resume()
    const granted = await claiming
    await archiving

    if (granted.outcome !== 'granted') throw new Error('bad fixture')
    expect((await db.select().from(slotClaims).where(eq(slotClaims.id, granted.claim.id!)))[0]).toMatchObject({
      status: 'released',
      terminalReason: 'squad_archived',
    })
    expect((await db.select().from(slotPools).where(eq(slotPools.squadId, squad.id)))[0]!.unregisteredAt).not.toBeNull()
  })

  test('a claim after archive finds no pool', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const claimer = await createAgent(squad.id)

    await squad.archive()
    await expect(claimSlot(squad.id, 'tests', claimer.id)).rejects.toMatchObject({ code: 'pool_not_found' })
    await expect(subscribeSlot(squad.id, 'tests', claimer.id)).rejects.toMatchObject({ code: 'pool_not_found' })
  })
})

describe('archived squads are inert while retirement lags', () => {
  test('use and admin store operations deny lagged archived squads', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const holder = await createAgent(squad.id)
    const outsider = await createAgent(squad.id)
    await claimSlot(squad.id, 'tests', holder.id)

    await markArchivedWithoutRetirement(squad.id)

    await expect(claimSlot(squad.id, 'tests', outsider.id)).rejects.toMatchObject({ code: 'pool_not_found' })
    await expect(subscribeSlot(squad.id, 'tests', outsider.id)).rejects.toMatchObject({ code: 'pool_not_found' })
    await expect(getPool(squad.id, 'tests', { agentId: outsider.id, diagnostics: false })).rejects.toMatchObject({
      code: 'pool_not_found',
    })
    await expect(listPools(squad.id, { agentId: outsider.id, diagnostics: false })).resolves.toEqual([])
    await expect(registerPool({ squadId: squad.id, key: 'fresh', createdBy: 'test' })).rejects.toMatchObject({
      code: 'squad_not_found',
    })
  })

  test('reconciliation inventory excludes lagged archived pools without touching them', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const holder = await createAgent(squad.id)
    const successor = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', holder.id)
    if (granted.outcome !== 'granted') throw new Error('bad fixture')
    await subscribeSlot(squad.id, 'tests', successor.id)

    await markArchivedWithoutRetirement(squad.id)
    const summary = await reconcileSlotsOnce()

    expect(summary.poolsProcessed).toBe(0)
    expect(summary.activeCount).toBe(0)
    expect(summary.queueDepth).toBe(0)
    // Inert means untouched: the lagged rows survive for the retiring transaction.
    expect((await db.select().from(slotClaims).where(eq(slotClaims.id, granted.claim.id!)))[0]).toMatchObject({
      status: 'active',
    })
    expect((await db.select().from(slotWaiters).where(eq(slotWaiters.ownerAgentId, successor.id)))[0]).toMatchObject({
      status: 'queued',
    })
  })

  test('lifecycle cleanup cannot promote a waiter into a lagged archived pool', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', capacity: 1, createdBy: 'test' })
    const holder = await createAgent(squad.id)
    const successor = await createAgent(squad.id)
    await claimSlot(squad.id, 'tests', holder.id)
    await subscribeSlot(squad.id, 'tests', successor.id)

    await markArchivedWithoutRetirement(squad.id)
    await makeDormant(holder)

    expect((await db.select().from(slotWaiters).where(eq(slotWaiters.ownerAgentId, successor.id)))[0]).toMatchObject({
      status: 'canceled',
      terminalReason: 'squad_archived',
    })
    expect(await db.select().from(slotClaims).where(eq(slotClaims.ownerAgentId, successor.id))).toHaveLength(0)
    const [pool] = await db.select({ id: slotPools.id }).from(slotPools).where(eq(slotPools.squadId, squad.id))
    expect(await db.select().from(slotNotifications).where(eq(slotNotifications.poolId, pool!.id))).toHaveLength(0)
  })
})
