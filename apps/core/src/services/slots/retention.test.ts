import { afterEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { agents, db, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { registerPool } from './store'
import {
  SLOT_PRUNE_BATCH_SIZE,
  SLOT_PRUNE_MAX_BATCHES,
  pruneTerminalSlotState,
  slotTerminalRetentionFloor,
} from './retention'

const squadIds: string[] = []
const agentIds: string[] = []
const DAY_MS = 24 * 60 * 60 * 1000

afterEach(async () => {
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
  const squad = await Squad.create({ name: `slot-retain-${crypto.randomUUID().slice(0, 8)}`, purpose: 'slot tests' })
  squadIds.push(squad.id)
  return squad
}

async function createAgent(squadId: string): Promise<string> {
  const [agent] = await db.insert(agents).values({ agentTypeId: 'slot-retain-test', squadId }).returning()
  agentIds.push(agent!.id)
  return agent!.id
}

interface TerminalFixture {
  squadId: string
  poolId: string
  claimId: string
  waiterId: string
  notificationId: string
  now: Date
}

/** One pool holding one terminal claim, one terminal waiter, one delivered notice. */
async function createTerminalFixture(ageDays: number, now = new Date()): Promise<TerminalFixture> {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const agentId = await createAgent(squad.id)
  const endedAt = new Date(now.getTime() - ageDays * DAY_MS)
  await db.update(slotPools).set({ unregisteredAt: endedAt }).where(eq(slotPools.id, pool.id))
  const [claim] = await db
    .insert(slotClaims)
    .values({
      poolId: pool.id,
      ownerAgentId: agentId,
      status: 'released',
      claimedAt: new Date(endedAt.getTime() - 60_000),
      expiresAt: new Date(endedAt.getTime() + 60_000),
      endedAt,
      terminalReason: 'released',
    })
    .returning()
  const [waiter] = await db
    .insert(slotWaiters)
    .values({
      poolId: pool.id,
      ownerAgentId: agentId,
      status: 'canceled',
      queuedAt: new Date(endedAt.getTime() - 120_000),
      endedAt,
      terminalReason: 'canceled',
    })
    .returning()
  const [notification] = await db
    .insert(slotNotifications)
    .values({
      poolId: pool.id,
      claimId: claim!.id,
      recipientAgentId: agentId,
      kind: 'expired',
      idempotencyKey: `retain:${claim!.id}`,
      status: 'delivered',
      deliveredAt: endedAt,
    })
    .returning()
  return {
    squadId: squad.id,
    poolId: pool.id,
    claimId: claim!.id,
    waiterId: waiter!.id,
    notificationId: notification!.id,
    now,
  }
}

test('the retention floor follows the squad-activity UTC-midnight convention', () => {
  const now = new Date('2026-09-04T15:44:20.123Z')
  expect(slotTerminalRetentionFloor(now)).toEqual(new Date('2026-08-05T00:00:00.000Z'))
})

test('prunes terminal rows past the floor in foreign-key order', async () => {
  const old = await createTerminalFixture(31)
  const fresh = await createTerminalFixture(29)

  const summary = await pruneTerminalSlotState({ now: old.now })

  expect(summary).toMatchObject({ notifications: 1, waiters: 1, claims: 1, pools: 1 })
  for (const [table, column, fixture] of [
    [slotNotifications, slotNotifications.id, old.notificationId],
    [slotWaiters, slotWaiters.id, old.waiterId],
    [slotClaims, slotClaims.id, old.claimId],
    [slotPools, slotPools.id, old.poolId],
  ] as const) {
    expect(await db.select({ id: column }).from(table).where(eq(column, fixture))).toHaveLength(0)
  }
  // Rows inside the recovery window survive untouched.
  expect(await db.select().from(slotClaims).where(eq(slotClaims.id, fresh.claimId))).toHaveLength(1)
  expect(await db.select().from(slotWaiters).where(eq(slotWaiters.id, fresh.waiterId))).toHaveLength(1)
  expect(await db.select().from(slotNotifications).where(eq(slotNotifications.id, fresh.notificationId))).toHaveLength(
    1
  )
  expect(await db.select().from(slotPools).where(eq(slotPools.id, fresh.poolId))).toHaveLength(1)
})

test('preserves every live or in-flight state regardless of age', async () => {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', capacity: 2, createdBy: 'test' })
  const holder = await createAgent(squad.id)
  const waiter = await createAgent(squad.id)
  const ancient = new Date(Date.now() - 400 * DAY_MS)
  const [activeClaim] = await db
    .insert(slotClaims)
    .values({
      poolId: pool.id,
      ownerAgentId: holder,
      status: 'active',
      claimedAt: ancient,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning()
  const [queuedWaiter] = await db
    .insert(slotWaiters)
    .values({ poolId: pool.id, ownerAgentId: waiter, status: 'queued', queuedAt: ancient })
    .returning()
  const [pendingNotification] = await db
    .insert(slotNotifications)
    .values({
      poolId: pool.id,
      claimId: activeClaim!.id,
      recipientAgentId: holder,
      kind: 'granted',
      idempotencyKey: `live:${activeClaim!.id}`,
      status: 'pending',
      nextAttemptAt: ancient,
    })
    .returning()
  // A registered (not unregistered) pool is never retention-eligible.
  await db.update(slotPools).set({ createdAt: ancient, updatedAt: ancient }).where(eq(slotPools.id, pool.id))

  const summary = await pruneTerminalSlotState()

  expect(summary).toEqual({ notifications: 0, waiters: 0, claims: 0, pools: 0 })
  expect(await db.select().from(slotClaims).where(eq(slotClaims.id, activeClaim!.id))).toHaveLength(1)
  expect(await db.select().from(slotWaiters).where(eq(slotWaiters.id, queuedWaiter!.id))).toHaveLength(1)
  expect(
    await db.select().from(slotNotifications).where(eq(slotNotifications.id, pendingNotification!.id))
  ).toHaveLength(1)
  expect(await db.select().from(slotPools).where(eq(slotPools.id, pool.id))).toHaveLength(1)
})

test('a terminal claim waits for its referencing terminal waiter to age out first', async () => {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const agentId = await createAgent(squad.id)
  const now = new Date()
  // Old terminal claim still referenced by a recently-granted waiter row.
  const [claim] = await db
    .insert(slotClaims)
    .values({
      poolId: pool.id,
      ownerAgentId: agentId,
      status: 'released',
      claimedAt: new Date(now.getTime() - 60 * DAY_MS),
      expiresAt: new Date(now.getTime() - 59 * DAY_MS),
      endedAt: new Date(now.getTime() - 58 * DAY_MS),
      terminalReason: 'released',
    })
    .returning()
  const [waiter] = await db
    .insert(slotWaiters)
    .values({
      poolId: pool.id,
      ownerAgentId: agentId,
      status: 'granted',
      resultingClaimId: claim!.id,
      queuedAt: new Date(now.getTime() - 2 * DAY_MS),
      endedAt: new Date(now.getTime() - DAY_MS),
      terminalReason: 'granted',
    })
    .returning()

  const first = await pruneTerminalSlotState({ now })
  expect(first).toMatchObject({ waiters: 0, claims: 0 })
  expect(await db.select().from(slotClaims).where(eq(slotClaims.id, claim!.id))).toHaveLength(1)

  // Once the waiter passes the floor, both rows converge in one pass.
  await db
    .update(slotWaiters)
    .set({ endedAt: new Date(now.getTime() - 32 * DAY_MS) })
    .where(eq(slotWaiters.id, waiter!.id))
  const second = await pruneTerminalSlotState({ now })
  expect(second).toMatchObject({ waiters: 1, claims: 1 })
  expect(await db.select().from(slotClaims).where(eq(slotClaims.id, claim!.id))).toHaveLength(0)
})

test('an unregistered pool is pruned only after all of its history ages out', async () => {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const agentId = await createAgent(squad.id)
  const now = new Date()
  await db
    .update(slotPools)
    .set({ unregisteredAt: new Date(now.getTime() - 40 * DAY_MS) })
    .where(eq(slotPools.id, pool.id))
  const [claim] = await db
    .insert(slotClaims)
    .values({
      poolId: pool.id,
      ownerAgentId: agentId,
      status: 'released',
      claimedAt: new Date(now.getTime() - 50 * DAY_MS),
      expiresAt: new Date(now.getTime() - 49 * DAY_MS),
      endedAt: new Date(now.getTime() - 2 * DAY_MS),
      terminalReason: 'released',
    })
    .returning()

  const first = await pruneTerminalSlotState({ now })
  expect(first).toMatchObject({ pools: 0 })
  expect(await db.select().from(slotPools).where(eq(slotPools.id, pool.id))).toHaveLength(1)

  await db
    .update(slotClaims)
    .set({ endedAt: new Date(now.getTime() - 35 * DAY_MS) })
    .where(eq(slotClaims.id, claim!.id))
  const second = await pruneTerminalSlotState({ now })
  expect(second).toMatchObject({ claims: 1, pools: 1 })
  expect(await db.select().from(slotPools).where(eq(slotPools.id, pool.id))).toHaveLength(0)
})

test('one pass is bounded by batch size times max batches', async () => {
  expect(SLOT_PRUNE_BATCH_SIZE).toBe(1_000)
  expect(SLOT_PRUNE_MAX_BATCHES).toBe(5)
  const batchSize = 3
  const maxBatches = 2
  const total = batchSize * maxBatches + 5
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', capacity: 1, createdBy: 'test' })
  const agentId = await createAgent(squad.id)
  const now = new Date()
  const endedAt = new Date(now.getTime() - 40 * DAY_MS)
  const claims = await db
    .insert(slotClaims)
    .values(
      Array.from({ length: total }, () => ({
        poolId: pool.id,
        ownerAgentId: agentId,
        status: 'expired' as const,
        claimedAt: endedAt,
        expiresAt: endedAt,
        endedAt,
        terminalReason: 'timed_out',
      }))
    )
    .returning()
  await db.insert(slotWaiters).values(
    claims.map(() => ({
      poolId: pool.id,
      ownerAgentId: agentId,
      status: 'canceled' as const,
      queuedAt: endedAt,
      endedAt,
      terminalReason: 'canceled',
    }))
  )
  await db.insert(slotNotifications).values(
    claims.map((claim) => ({
      poolId: pool.id,
      claimId: claim.id,
      recipientAgentId: agentId,
      kind: 'expired' as const,
      idempotencyKey: `bounded:${claim.id}`,
      status: 'delivered' as const,
      deliveredAt: endedAt,
    }))
  )

  const first = await pruneTerminalSlotState({ now, batchSize, maxBatches })
  expect(first.notifications).toBe(batchSize * maxBatches)
  expect(first.waiters).toBe(batchSize * maxBatches)
  expect(first.claims).toBe(batchSize * maxBatches)
  // The registered pool itself is never retention-eligible.
  expect(first.pools).toBe(0)

  const remaining = await db.select({ id: slotClaims.id }).from(slotClaims).where(eq(slotClaims.poolId, pool.id))
  expect(remaining).toHaveLength(total - batchSize * maxBatches)

  const second = await pruneTerminalSlotState({ now, batchSize, maxBatches })
  expect(second.claims).toBe(total - batchSize * maxBatches)
})
