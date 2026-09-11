import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { agents, db, slotClaims, slotNotifications, slotPools, slotWaiters, squads, type DbTx } from '../../db'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { makeDormant, setDormancyEffectHookForTest, terminate, wakeInTransaction } from '../agent/lifecycle'
import {
  claimSlot,
  discoverAgentSlotPoolIds,
  registerPool,
  releaseSlot,
  setSlotCleanupAfterDiscoveryHookForTest,
  setSlotPromptDrainEnabledForTest,
  subscribeSlot,
} from './store'
import { slotNotificationNotifier } from './notifications'

// Store-state assertions stay deterministic: the prompt drain stays off except
// in the test that explicitly exercises it.
beforeAll(() => setSlotPromptDrainEnabledForTest(false))
afterAll(() => setSlotPromptDrainEnabledForTest(true))

const squadIds: string[] = []
const agentIds: string[] = []

afterEach(async () => {
  setDormancyEffectHookForTest(undefined)
  setSlotCleanupAfterDiscoveryHookForTest(undefined)
  const poolIds =
    squadIds.length === 0
      ? []
      : (await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))).map(
          (row) => row.id
        )
  if (poolIds.length > 0) {
    await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
    await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
    await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
    await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
  }
  if (agentIds.length > 0) await db.delete(agents).where(inArray(agents.id, agentIds))
  if (squadIds.length > 0) await db.delete(squads).where(inArray(squads.id, squadIds))
  squadIds.length = 0
  agentIds.length = 0
})

async function fixtureAgent(squadId: string): Promise<Agent> {
  const [row] = await db.insert(agents).values({ agentTypeId: 'slot-lifecycle-test', squadId }).returning()
  agentIds.push(row!.id)
  return new Agent(row!)
}

test('dormancy discovery is one statement so promotion cannot fall between snapshots', async () => {
  const poolId = crypto.randomUUID()
  const execute = mock(async () => [{ poolId }])
  const tx = { execute } as unknown as DbTx

  await expect(discoverAgentSlotPoolIds(tx, crypto.randomUUID())).resolves.toEqual([poolId])
  expect(execute).toHaveBeenCalledTimes(1)
})

test('phase-one dormancy atomically cleans slots even when later effects fail', async () => {
  const squad = await Squad.create({ name: `slot-life-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  await registerPool({ squadId: squad.id, key: 'a', createdBy: 'test' })
  await registerPool({ squadId: squad.id, key: 'b', createdBy: 'test' })
  const target = await fixtureAgent(squad.id)
  const holder = await fixtureAgent(squad.id)
  const successor = await fixtureAgent(squad.id)
  await claimSlot(squad.id, 'a', target.id)
  await claimSlot(squad.id, 'b', holder.id)
  await subscribeSlot(squad.id, 'a', successor.id)
  await subscribeSlot(squad.id, 'b', target.id)
  setDormancyEffectHookForTest(async () => {
    throw new Error('injected phase-two failure')
  })

  await expect(makeDormant(target)).rejects.toThrow('injected phase-two failure')

  expect((await Agent.mustFind(target.id)).status).toBe('dormant')
  const liveTargetState = await Promise.all([
    db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.ownerAgentId, target.id), eq(slotClaims.status, 'active'))),
    db
      .select()
      .from(slotWaiters)
      .where(and(eq(slotWaiters.ownerAgentId, target.id), eq(slotWaiters.status, 'queued'))),
  ])
  expect(liveTargetState.flat()).toEqual([])
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.ownerAgentId, successor.id), eq(slotClaims.status, 'active')))
  ).toHaveLength(1)
})

test('promotion committing after dormancy discovery is fenced by the discovered pool', async () => {
  setDormancyEffectHookForTest(async () => {})
  const squad = await Squad.create({ name: `slot-promote-race-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const holder = await fixtureAgent(squad.id)
  const target = await fixtureAgent(squad.id)
  const held = await claimSlot(squad.id, 'tests', holder.id)
  if (held.outcome !== 'granted') throw new Error('bad holder fixture')
  await subscribeSlot(squad.id, 'tests', target.id)

  let discovered!: () => void
  const atDiscovery = new Promise<void>((resolve) => {
    discovered = resolve
  })
  let allowCleanup!: () => void
  const cleanupAllowed = new Promise<void>((resolve) => {
    allowCleanup = resolve
  })
  setSlotCleanupAfterDiscoveryHookForTest(async () => {
    discovered()
    await cleanupAllowed
  })

  const dormancy = makeDormant(target)
  await atDiscovery
  await releaseSlot(squad.id, 'tests', holder.id, held.claim.id!)
  allowCleanup()
  await dormancy

  expect((await Agent.mustFind(target.id)).status).toBe('dormant')
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.ownerAgentId, target.id), eq(slotClaims.status, 'active')))
  ).toEqual([])
}, 15_000)

test('waking a dormant agent does not restore its prior slot state', async () => {
  setDormancyEffectHookForTest(async () => {})
  const squad = await Squad.create({ name: `slot-wake-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const target = await fixtureAgent(squad.id)
  await claimSlot(squad.id, 'tests', target.id)
  await makeDormant(target)
  await db.transaction(async (tx) => {
    await wakeInTransaction(tx, target.id)
  })

  expect((await Agent.mustFind(target.id)).status).toBe('idle')
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.ownerAgentId, target.id), eq(slotClaims.status, 'active')))
  ).toEqual([])
})

test('final termination is an idempotent fallback for dormant slot remnants', async () => {
  const squad = await Squad.create({ name: `slot-final-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const target = await fixtureAgent(squad.id)
  await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, target.id))
  await target.reload()
  await db.insert(slotClaims).values({
    poolId: pool.id,
    ownerAgentId: target.id,
    expiresAt: new Date(Date.now() + 60_000),
  })

  await terminate(target, { completeDormancy: async () => true, finalCleanup: async () => true })
  await terminate(target, { completeDormancy: async () => true, finalCleanup: async () => true })

  expect(
    await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.ownerAgentId, target.id), eq(slotClaims.status, 'active')))
  ).toEqual([])
})

test('claim racing dormancy cannot leave a dormant holder', async () => {
  setDormancyEffectHookForTest(async () => {})
  const squad = await Squad.create({ name: `slot-race-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const target = await fixtureAgent(squad.id)

  await Promise.allSettled([makeDormant(target), claimSlot(squad.id, 'tests', target.id)])

  expect((await Agent.mustFind(target.id)).status).toBe('dormant')
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.ownerAgentId, target.id), eq(slotClaims.status, 'active')))
  ).toEqual([])
}, 15_000)

test('dormancy cleanup schedules the prompt drain only after its transaction commits', async () => {
  setSlotPromptDrainEnabledForTest(true)
  const squad = await Squad.create({ name: `slot-drain-${crypto.randomUUID()}`, purpose: 'test' })
  squadIds.push(squad.id)
  await registerPool({ squadId: squad.id, key: 'a', createdBy: 'test' })
  const holder = await fixtureAgent(squad.id)
  const successor = await fixtureAgent(squad.id)
  await claimSlot(squad.id, 'a', holder.id)
  await subscribeSlot(squad.id, 'a', successor.id)

  const original = slotNotificationNotifier.drainSoon.bind(slotNotificationNotifier)
  const committedAtSchedule: Array<Promise<boolean>> = []
  let scheduled = 0
  slotNotificationNotifier.drainSoon = () => {
    scheduled += 1
    // The drain may only be scheduled once the promotion is committed.
    committedAtSchedule.push(
      db
        .select({ id: slotClaims.id })
        .from(slotClaims)
        .where(and(eq(slotClaims.ownerAgentId, successor.id), eq(slotClaims.status, 'active')))
        .then((rows) => rows.length === 1)
    )
    original()
  }
  try {
    await makeDormant(holder)
    expect(scheduled).toBe(1)
    expect(await Promise.all(committedAtSchedule)).toEqual([true])
  } finally {
    slotNotificationNotifier.drainSoon = original
    setSlotPromptDrainEnabledForTest(false)
  }
})
