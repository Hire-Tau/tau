import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { agents, db, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import {
  DEFAULT_SLOT_CLAIM_TIMEOUT_MS,
  MAX_SLOT_CAPACITY,
  MAX_SLOT_CLAIM_TIMEOUT_MS,
  MIN_SLOT_CLAIM_TIMEOUT_MS,
  SlotServiceError,
} from './types'
import {
  claimSlot,
  getPool,
  listPools,
  registerPool,
  releaseSlot,
  renewSlot,
  setSlotAfterPoolLockHookForTest,
  setSlotProjectionAfterClaimsHookForTest,
  subscribeSlot,
  unregisterPool,
  unsubscribeSlot,
  updatePool,
} from './store'

const squadIds: string[] = []
const agentIds: string[] = []
const acquirePoolKeys = ['activeCount', 'availableCount', 'capacity', 'key', 'queuedCount']

function expectBoundedAcquireResult(result: { pool: object; claim?: object; waiter?: object }): void {
  expect(Object.keys(result.pool).sort()).toEqual(acquirePoolKeys)
  expect(Object.values(result.pool).some(Array.isArray)).toBe(false)
  expect(JSON.stringify(result)).not.toContain('terminalStates')
  expect(JSON.stringify(result)).not.toContain('holders')
  if (result.claim) expect(Object.keys(result.claim).sort()).toEqual(['expiresAt', 'id'])
  if (result.waiter) expect(Object.keys(result.waiter)).toEqual(['id'])
}

afterEach(async () => {
  setSystemTime()
  setSlotAfterPoolLockHookForTest(undefined)
  setSlotProjectionAfterClaimsHookForTest(undefined)
  if (squadIds.length === 0) return
  const poolIds = (
    await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))
  ).map((row) => row.id)
  if (poolIds.length > 0) {
    await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
    await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
    await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
  }
  await db.delete(slotPools).where(inArray(slotPools.squadId, squadIds))
  if (agentIds.length > 0) await db.delete(agents).where(inArray(agents.id, agentIds))
  await db.delete(squads).where(inArray(squads.id, squadIds))
  squadIds.length = 0
  agentIds.length = 0
})

async function createSquad(): Promise<Squad> {
  const squad = await Squad.create({ name: `slots-${crypto.randomUUID().slice(0, 8)}`, purpose: 'slot tests' })
  squadIds.push(squad.id)
  return squad
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

async function createAgent(squadId: string, status: 'idle' | 'dormant' = 'idle'): Promise<string> {
  const [agent] = await db.insert(agents).values({ agentTypeId: 'slot-test', squadId, status }).returning()
  agentIds.push(agent!.id)
  return agent!.id
}

describe('slot pool administration', () => {
  test('normalizes keys and applies pool defaults', async () => {
    const squad = await createSquad()
    const pool = await registerPool({ squadId: squad.id, key: '  Tests  ', createdBy: 'agent:test' })

    expect(pool.key).toBe('tests')
    expect(pool.capacity).toBe(1)
    expect(pool.claimTimeoutMs).toBe(DEFAULT_SLOT_CLAIM_TIMEOUT_MS)
  })

  test('rejects invalid keys, capacity, and timeout', async () => {
    const squad = await createSquad()
    await expect(registerPool({ squadId: squad.id, key: 'Bad Key', createdBy: 'agent:test' })).rejects.toMatchObject({
      code: 'invalid_slot_key',
    })
    await expect(
      registerPool({ squadId: squad.id, key: 'tests', capacity: 0, createdBy: 'agent:test' })
    ).rejects.toMatchObject({ code: 'invalid_capacity' })
    await expect(
      registerPool({ squadId: squad.id, key: 'tests', capacity: MAX_SLOT_CAPACITY + 1, createdBy: 'agent:test' })
    ).rejects.toMatchObject({ code: 'invalid_capacity' })
    await expect(
      registerPool({
        squadId: squad.id,
        key: 'tests',
        claimTimeoutMs: MIN_SLOT_CLAIM_TIMEOUT_MS - 1,
        createdBy: 'agent:test',
      })
    ).rejects.toMatchObject({ code: 'invalid_timeout' })
    await expect(
      registerPool({
        squadId: squad.id,
        key: 'tests',
        claimTimeoutMs: MAX_SLOT_CLAIM_TIMEOUT_MS + 1,
        createdBy: 'agent:test',
      })
    ).rejects.toBeInstanceOf(SlotServiceError)
  })

  test('prevents duplicate active keys', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    await expect(registerPool({ squadId: squad.id, key: 'TESTS', createdBy: 'agent:test' })).rejects.toMatchObject({
      code: 'pool_exists',
    })
  })

  test('updates configuration without rewriting active claims', async () => {
    const squad = await createSquad()
    const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const expiry = new Date(Date.now() + 10 * 60_000)
    const [claim] = await db
      .insert(slotClaims)
      .values({ poolId: pool.id, ownerAgentId: crypto.randomUUID(), expiresAt: expiry })
      .returning()

    const updated = await updatePool(squad.id, 'tests', { capacity: 3, claimTimeoutMs: 2 * 60 * 60_000 })

    expect(updated.capacity).toBe(3)
    expect(updated.claimTimeoutMs).toBe(2 * 60 * 60_000)
    const [persisted] = await db.select().from(slotClaims).where(eq(slotClaims.id, claim!.id))
    expect(persisted!.expiresAt).toEqual(expiry)
  })

  test('unregisters only an empty pool and re-registration creates a new identity', async () => {
    const squad = await createSquad()
    const original = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    await db.insert(slotClaims).values({
      poolId: original.id,
      ownerAgentId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await expect(unregisterPool(squad.id, 'tests')).rejects.toMatchObject({ code: 'pool_busy' })
    await db.delete(slotClaims).where(eq(slotClaims.poolId, original.id))

    await unregisterPool(squad.id, 'tests')
    const replacement = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })

    expect(replacement.id).not.toBe(original.id)
  })

  test('lists active pools and returns an empty redacted projection', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })

    const [summary] = await listPools(squad.id, { diagnostics: false })
    const detail = await getPool(squad.id, 'tests', { diagnostics: false })

    expect(summary).toMatchObject({ key: 'tests', activeCount: 0, availableCount: 1, queuedCount: 0 })
    expect(summary!.holders).toEqual([])
    expect(detail.oldestWaiterAgeMs).toBeNull()
    expect('terminalStates' in detail).toBe(false)
  })
})

describe('slot claims', () => {
  test('returns exact bounded acquisition envelopes for every claim outcome', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const holder = await createAgent(squad.id)
    const queuedOwner = await createAgent(squad.id)
    const unavailableOwner = await createAgent(squad.id)

    const granted = await claimSlot(squad.id, 'tests', holder)
    const queued = await claimSlot(squad.id, 'tests', queuedOwner)
    const unavailable = await claimSlot(squad.id, 'tests', unavailableOwner, { subscribe: false })

    expectBoundedAcquireResult(granted)
    expectBoundedAcquireResult(queued)
    expectBoundedAcquireResult(unavailable)
  })

  test('serializes concurrent claims at pool capacity', async () => {
    const squad = await createSquad()
    const pool = await registerPool({ squadId: squad.id, key: 'tests', capacity: 2, createdBy: 'agent:test' })
    const owners = await Promise.all(Array.from({ length: 8 }, () => createAgent(squad.id)))

    const results = await Promise.all(owners.map((owner) => claimSlot(squad.id, 'tests', owner)))

    expect(results.filter((result) => result.outcome === 'granted')).toHaveLength(2)
    const persisted = await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
    expect(persisted).toHaveLength(2)
  })

  test('returns the same claim when one agent races duplicate requests', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', capacity: 2, createdBy: 'agent:test' })
    const owner = await createAgent(squad.id)

    const results = await Promise.all(Array.from({ length: 5 }, () => claimSlot(squad.id, 'tests', owner)))

    expect(results.every((result) => result.outcome === 'granted')).toBe(true)
    const ids = results.map((result) => (result.outcome === 'granted' ? result.claim.id : undefined))
    expect(new Set(ids).size).toBe(1)
  })

  test('rejects dormant and cross-squad owners', async () => {
    const squad = await createSquad()
    const otherSquad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const dormant = await createAgent(squad.id, 'dormant')
    const foreign = await createAgent(otherSquad.id)

    await expect(claimSlot(squad.id, 'tests', dormant)).rejects.toMatchObject({ code: 'agent_not_live' })
    await expect(claimSlot(squad.id, 'tests', foreign)).rejects.toMatchObject({ code: 'agent_not_in_squad' })
  })
})

describe('slot FIFO subscriptions and release', () => {
  test('returns exact bounded acquisition envelopes for granted and queued subscriptions', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const holder = await createAgent(squad.id)
    const waiter = await createAgent(squad.id)

    const granted = await subscribeSlot(squad.id, 'tests', holder)
    const queued = await subscribeSlot(squad.id, 'tests', waiter)

    expectBoundedAcquireResult(granted)
    expectBoundedAcquireResult(queued)
  })

  test('acquisition size is independent of large holder and terminal history sets', async () => {
    const squad = await createSquad()
    const pool = await registerPool({ squadId: squad.id, key: 'tests', capacity: 30, createdBy: 'agent:test' })
    const owners = await Promise.all(Array.from({ length: 31 }, () => createAgent(squad.id)))
    const terminalOwner = owners.at(-1)!
    const expiresAt = new Date(Date.now() + 60_000)
    await db
      .insert(slotClaims)
      .values(owners.slice(0, 30).map((ownerAgentId) => ({ poolId: pool.id, ownerAgentId, expiresAt })))
    await db.insert(slotClaims).values(
      Array.from({ length: 60 }, () => ({
        poolId: pool.id,
        ownerAgentId: terminalOwner,
        status: 'released' as const,
        expiresAt,
        endedAt: new Date(),
        terminalReason: 'released',
      }))
    )
    await db.insert(slotWaiters).values(
      Array.from({ length: 60 }, () => ({
        poolId: pool.id,
        ownerAgentId: terminalOwner,
        status: 'canceled' as const,
        endedAt: new Date(),
        terminalReason: 'canceled',
      }))
    )

    const result = await subscribeSlot(squad.id, 'tests', terminalOwner)

    expect(result.outcome).toBe('queued')
    expectBoundedAcquireResult(result)
    expect(JSON.stringify(result).length).toBeLessThan(1024)
  })

  test('subscribe grants free capacity then queues idempotently', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const holder = await createAgent(squad.id)
    const waiter = await createAgent(squad.id)

    expect((await subscribeSlot(squad.id, 'tests', holder)).outcome).toBe('granted')
    const first = await subscribeSlot(squad.id, 'tests', waiter)
    const retry = await subscribeSlot(squad.id, 'tests', waiter)

    expect(first.outcome).toBe('queued')
    expect(retry.outcome).toBe('queued')
    expect(first.outcome === 'queued' && retry.outcome === 'queued' && retry.waiter.id).toBe(
      first.outcome === 'queued' ? first.waiter.id : ''
    )
  })

  test('release promotes waiters in FIFO order', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const holder = await createAgent(squad.id)
    const waiterA = await createAgent(squad.id)
    const waiterB = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', holder)
    const first = await subscribeSlot(squad.id, 'tests', waiterA)
    const second = await subscribeSlot(squad.id, 'tests', waiterB)
    if (granted.outcome !== 'granted' || first.outcome !== 'queued' || second.outcome !== 'queued')
      throw new Error('bad fixture')

    await releaseSlot(squad.id, 'tests', holder, granted.claim.id!)

    const [persistedFirst] = await db.select().from(slotWaiters).where(eq(slotWaiters.id, first.waiter.id!))
    const [persistedSecond] = await db.select().from(slotWaiters).where(eq(slotWaiters.id, second.waiter.id!))
    expect(persistedFirst).toMatchObject({ status: 'granted' })
    expect(persistedFirst!.resultingClaimId).toBeString()
    expect(persistedSecond).toMatchObject({ status: 'queued' })
  })

  test('capacity increases promote only the oldest required waiters and decreases preserve holders', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', capacity: 1, createdBy: 'agent:test' })
    const owners = await Promise.all(Array.from({ length: 4 }, () => createAgent(squad.id)))
    await claimSlot(squad.id, 'tests', owners[0]!)
    await subscribeSlot(squad.id, 'tests', owners[1]!)
    await subscribeSlot(squad.id, 'tests', owners[2]!)
    await subscribeSlot(squad.id, 'tests', owners[3]!)

    await updatePool(squad.id, 'tests', { capacity: 3 })
    expect((await getPool(squad.id, 'tests', { diagnostics: true })).activeCount).toBe(3)
    expect((await getPool(squad.id, 'tests', { diagnostics: true })).queuedCount).toBe(1)

    await updatePool(squad.id, 'tests', { capacity: 1 })
    expect((await getPool(squad.id, 'tests', { diagnostics: true })).activeCount).toBe(3)
    const newcomer = await createAgent(squad.id)
    // Claiming into a full pool queues by default; --no-subscribe keeps the
    // old immediate-only answer.
    expect((await claimSlot(squad.id, 'tests', newcomer, { subscribe: false })).outcome).toBe('unavailable')
  })

  test('foreign and stale claim identifiers cannot release successor pools', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const owner = await createAgent(squad.id)
    const foreign = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', owner)
    if (granted.outcome !== 'granted') throw new Error('bad fixture')

    await expect(releaseSlot(squad.id, 'tests', foreign, granted.claim.id!)).rejects.toMatchObject({
      code: 'claim_not_found',
    })
    expect((await releaseSlot(squad.id, 'tests', owner, granted.claim.id!)).outcome).toBe('released')
    expect((await releaseSlot(squad.id, 'tests', owner, granted.claim.id!)).outcome).toBe('already_released')
    await unregisterPool(squad.id, 'tests')
    const replacement = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    expect((await releaseSlot(squad.id, 'tests', owner, granted.claim.id!)).outcome).toBe('already_released')
    expect((await getPool(squad.id, replacement.key, { diagnostics: true })).activeCount).toBe(0)
  })
})

describe('slot renewal, expiry, and unsubscribe', () => {
  test('renew uses database time and the current pool timeout', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', claimTimeoutMs: 60_000, createdBy: 'agent:test' })
    const owner = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', owner)
    if (granted.outcome !== 'granted') throw new Error('bad fixture')
    const originalExpiry = granted.claim.expiresAt
    await updatePool(squad.id, 'tests', { claimTimeoutMs: 120_000 })

    const renewed = await renewSlot(squad.id, 'tests', owner, granted.claim.id!)

    expect(renewed.outcome).toBe('renewed')
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(originalExpiry.getTime())
    expect(renewed.expiresAt.getTime() - Date.now()).toBeGreaterThan(115_000)
  })

  test('overdue renewal expires and never resurrects the claim', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const owner = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', owner)
    if (granted.outcome !== 'granted') throw new Error('bad fixture')
    await db
      .update(slotClaims)
      .set({ expiresAt: new Date(0) })
      .where(eq(slotClaims.id, granted.claim.id!))

    expect((await renewSlot(squad.id, 'tests', owner, granted.claim.id!)).outcome).toBe('expired')
    expect((await renewSlot(squad.id, 'tests', owner, granted.claim.id!)).outcome).toBe('expired')
  })

  test('unsubscribe cancels a queued waiter idempotently', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    await claimSlot(squad.id, 'tests', await createAgent(squad.id))
    const owner = await createAgent(squad.id)
    const queued = await subscribeSlot(squad.id, 'tests', owner)
    if (queued.outcome !== 'queued') throw new Error('bad fixture')

    expect((await unsubscribeSlot(squad.id, 'tests', owner, queued.waiter.id!)).outcome).toBe('canceled')
    expect((await unsubscribeSlot(squad.id, 'tests', owner, queued.waiter.id!)).outcome).toBe('canceled')
  })

  test('unsubscribe reports an already granted waiter and requires explicit release', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const holder = await createAgent(squad.id)
    const owner = await createAgent(squad.id)
    const claim = await claimSlot(squad.id, 'tests', holder)
    const queued = await subscribeSlot(squad.id, 'tests', owner)
    if (claim.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')
    await releaseSlot(squad.id, 'tests', holder, claim.claim.id!)

    const result = await unsubscribeSlot(squad.id, 'tests', owner, queued.waiter.id!)

    expect(result.outcome).toBe('already_granted')
    expect(result.outcome === 'already_granted' && result.claimId).toBeString()
  })

  test('foreign claim and waiter identifiers return stable not-found errors', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
    const owner = await createAgent(squad.id)
    const foreign = await createAgent(squad.id)
    const claim = await claimSlot(squad.id, 'tests', owner)
    const queued = await subscribeSlot(squad.id, 'tests', foreign)
    if (claim.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')

    await expect(renewSlot(squad.id, 'tests', foreign, claim.claim.id!)).rejects.toMatchObject({
      code: 'claim_not_found',
    })
    await expect(unsubscribeSlot(squad.id, 'tests', owner, queued.waiter.id!)).rejects.toMatchObject({
      code: 'waiter_not_found',
    })
  })
})

test('projection keeps exactly one caller state when promotion commits between live-state reads', async () => {
  const squad = await createSquad()
  await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const holder = await createAgent(squad.id)
  const waiter = await createAgent(squad.id)
  const held = await claimSlot(squad.id, 'tests', holder)
  const queued = await subscribeSlot(squad.id, 'tests', waiter)
  if (held.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')
  let transitioned = false
  setSlotProjectionAfterClaimsHookForTest(async () => {
    if (transitioned) return
    transitioned = true
    await releaseSlot(squad.id, 'tests', holder, held.claim.id!)
  })

  const duringPromotion = await getPool(squad.id, 'tests', { agentId: waiter, diagnostics: false })
  expect([duringPromotion.callerClaim, duringPromotion.callerWaiter].filter(Boolean)).toHaveLength(1)
  expect(duringPromotion.callerWaiter?.id).toBe(queued.waiter.id)

  setSlotProjectionAfterClaimsHookForTest(undefined)
  const afterPromotion = await getPool(squad.id, 'tests', { agentId: waiter, diagnostics: false })
  expect(afterPromotion.callerClaim?.id).toBeString()
  expect(afterPromotion.callerWaiter).toBeUndefined()
})

test('populated projections expose live state without terminal history', async () => {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const holder = await createAgent(squad.id)
  const waiter = await createAgent(squad.id)
  const held = await claimSlot(squad.id, 'tests', holder)
  const queued = await subscribeSlot(squad.id, 'tests', waiter)
  if (held.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')
  await db
    .update(slotWaiters)
    .set({ queuedAt: new Date(Date.now() - 60_000) })
    .where(eq(slotWaiters.id, queued.waiter.id!))
  const now = new Date()
  await db
    .insert(slotClaims)
    .values({
      poolId: pool.id,
      ownerAgentId: holder,
      status: 'released',
      expiresAt: now,
      endedAt: now,
      terminalReason: 'released',
    })
    .returning()
  await db
    .insert(slotWaiters)
    .values({
      poolId: pool.id,
      ownerAgentId: holder,
      status: 'canceled',
      endedAt: now,
      terminalReason: 'canceled',
    })
    .returning()
  await db.insert(slotClaims).values(
    Array.from({ length: 30 }, (_, index) => ({
      poolId: pool.id,
      ownerAgentId: crypto.randomUUID(),
      status: 'released' as const,
      expiresAt: now,
      endedAt: new Date(now.getTime() - index - 1),
      terminalReason: 'released',
    }))
  )
  await db.insert(slotWaiters).values(
    Array.from({ length: 30 }, (_, index) => ({
      poolId: pool.id,
      ownerAgentId: crypto.randomUUID(),
      status: 'canceled' as const,
      endedAt: new Date(now.getTime() - index - 31),
      terminalReason: 'canceled',
    }))
  )

  const ordinary = await getPool(squad.id, 'tests', { agentId: waiter, diagnostics: false })
  expect(ordinary.callerWaiter?.id).toBe(queued.waiter.id)
  expect(ordinary.holders[0]?.id).toBeUndefined()
  expect(ordinary.oldestWaiterAgeMs).toBeGreaterThanOrEqual(59_000)

  const own = await getPool(squad.id, 'tests', { agentId: holder, diagnostics: false })
  expect(own.callerClaim?.id).toBe(held.claim.id)
  expect('terminalStates' in own).toBe(false)

  const diagnostics = await getPool(squad.id, 'tests', { diagnostics: true })
  expect(diagnostics.holders[0]?.id).toBe(held.claim.id)
  expect('terminalStates' in diagnostics).toBe(false)
})

describe('serialized terminal races', () => {
  test('release winning against renew produces one released terminal outcome', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const owner = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', owner)
    if (granted.outcome !== 'granted') throw new Error('bad fixture')
    const barrier = pauseOperation('release')

    const release = releaseSlot(squad.id, 'tests', owner, granted.claim.id!)
    await barrier.entered
    const renew = renewSlot(squad.id, 'tests', owner, granted.claim.id!)
    barrier.resume()

    await expect(release).resolves.toMatchObject({ outcome: 'released' })
    await expect(renew).resolves.toMatchObject({ outcome: 'already_released' })
  })

  test('DB expiry winning against a paused renew cannot be extended', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const owner = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', owner)
    if (granted.outcome !== 'granted') throw new Error('bad fixture')
    const barrier = pauseOperation('renew')

    const renewal = renewSlot(squad.id, 'tests', owner, granted.claim.id!)
    await barrier.entered
    await db
      .update(slotClaims)
      .set({ expiresAt: new Date(0) })
      .where(eq(slotClaims.id, granted.claim.id!))
    barrier.resume()

    await expect(renewal).resolves.toMatchObject({ outcome: 'expired' })
  })

  test('grant winning against unsubscribe returns the resulting live claim', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const holder = await createAgent(squad.id)
    const waiter = await createAgent(squad.id)
    const held = await claimSlot(squad.id, 'tests', holder)
    const queued = await subscribeSlot(squad.id, 'tests', waiter)
    if (held.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')
    const barrier = pauseOperation('release')

    const release = releaseSlot(squad.id, 'tests', holder, held.claim.id!)
    await barrier.entered
    const unsubscribe = unsubscribeSlot(squad.id, 'tests', waiter, queued.waiter.id!)
    barrier.resume()
    await release

    await expect(unsubscribe).resolves.toMatchObject({ outcome: 'already_granted' })
  })

  test('concurrent release and expiry promote FIFO once per freed unit', async () => {
    const squad = await createSquad()
    const pool = await registerPool({ squadId: squad.id, key: 'tests', capacity: 2, createdBy: 'test' })
    const holders = await Promise.all([createAgent(squad.id), createAgent(squad.id)])
    const waiters = await Promise.all([createAgent(squad.id), createAgent(squad.id), createAgent(squad.id)])
    const firstHeld = await claimSlot(squad.id, 'tests', holders[0]!)
    const secondHeld = await claimSlot(squad.id, 'tests', holders[1]!)
    if (firstHeld.outcome !== 'granted' || secondHeld.outcome !== 'granted') throw new Error('bad fixture')
    const queued = []
    for (const owner of waiters) queued.push(await subscribeSlot(squad.id, 'tests', owner))
    if (queued.some((result) => result.outcome !== 'queued')) throw new Error('bad queue fixture')
    await db
      .update(slotClaims)
      .set({ expiresAt: new Date(0) })
      .where(eq(slotClaims.id, secondHeld.claim.id!))
    const barrier = pauseOperation('release')

    const release = releaseSlot(squad.id, 'tests', holders[0]!, firstHeld.claim.id!)
    await barrier.entered
    const expiry = renewSlot(squad.id, 'tests', holders[1]!, secondHeld.claim.id!)
    barrier.resume()
    await Promise.all([release, expiry])

    const live = await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.status, 'active')))
    expect(live.map((claim) => claim.ownerAgentId).sort()).toEqual(waiters.slice(0, 2).sort())
    expect(new Set(live.map((claim) => claim.id)).size).toBe(2)
    expect(
      await db
        .select()
        .from(slotWaiters)
        .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
    ).toMatchObject([{ ownerAgentId: waiters[2] }])
    expect(
      await db
        .select()
        .from(slotNotifications)
        .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'granted')))
    ).toHaveLength(2)
  })

  test('unregister racing release remains busy, then succeeds after release', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    const owner = await createAgent(squad.id)
    const held = await claimSlot(squad.id, 'tests', owner)
    if (held.outcome !== 'granted') throw new Error('bad fixture')
    const barrier = pauseOperation('unregister')

    const unregister = unregisterPool(squad.id, 'tests')
    await barrier.entered
    const release = releaseSlot(squad.id, 'tests', owner, held.claim.id!)
    barrier.resume()

    await expect(unregister).rejects.toMatchObject({ code: 'pool_busy' })
    await expect(release).resolves.toMatchObject({ outcome: 'released' })
    await expect(unregisterPool(squad.id, 'tests')).resolves.toMatchObject({ key: 'tests' })
  })
})

test('claim never bypasses an older waiter when capacity becomes free', async () => {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const holder = await createAgent(squad.id)
  const waiter = await createAgent(squad.id)
  const newcomer = await createAgent(squad.id)
  const held = await claimSlot(squad.id, 'tests', holder)
  const queued = await subscribeSlot(squad.id, 'tests', waiter)
  if (held.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')
  await db
    .update(slotClaims)
    .set({ status: 'released', endedAt: new Date(), terminalReason: 'released' })
    .where(eq(slotClaims.id, held.claim.id!))

  // The freed capacity goes to the older waiter, and the newcomer takes its
  // place in the queue rather than jumping it. The outcome label changed with
  // auto-subscribe; the fairness invariant did not.
  await expect(claimSlot(squad.id, 'tests', newcomer)).resolves.toMatchObject({ outcome: 'queued' })
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, waiter), eq(slotClaims.status, 'active')))
  ).toHaveLength(1)
  expect(
    await db
      .select()
      .from(slotClaims)
      .where(
        and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, newcomer), eq(slotClaims.status, 'active'))
      )
  ).toHaveLength(0)
})

test('claim without subscribe reports unavailable and queues nobody', async () => {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const holder = await createAgent(squad.id)
  const newcomer = await createAgent(squad.id)
  await claimSlot(squad.id, 'tests', holder)

  await expect(claimSlot(squad.id, 'tests', newcomer, { subscribe: false })).resolves.toMatchObject({
    outcome: 'unavailable',
  })
  expect(await db.select().from(slotWaiters).where(eq(slotWaiters.poolId, pool.id))).toHaveLength(0)
})

test('a blocked claim enqueues one FIFO waiter and is idempotent for the same agent', async () => {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const holder = await createAgent(squad.id)
  const newcomer = await createAgent(squad.id)
  await claimSlot(squad.id, 'tests', holder)

  const first = await claimSlot(squad.id, 'tests', newcomer)
  const second = await claimSlot(squad.id, 'tests', newcomer)
  if (first.outcome !== 'queued' || second.outcome !== 'queued') throw new Error('expected queued outcomes')
  // Re-claiming must not stack duplicate waiters for one agent.
  expect(second.waiter.id).toBe(first.waiter.id)
  expect(await db.select().from(slotWaiters).where(eq(slotWaiters.poolId, pool.id))).toHaveLength(1)
})

test('unsubscribe reports whether the granted claim is still live', async () => {
  const squad = await createSquad()
  await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const holder = await createAgent(squad.id)
  const waiter = await createAgent(squad.id)
  const held = await claimSlot(squad.id, 'tests', holder)
  const queued = await subscribeSlot(squad.id, 'tests', waiter)
  if (held.outcome !== 'granted' || queued.outcome !== 'queued') throw new Error('bad fixture')

  // Promote the waiter by releasing the holder's claim.
  await releaseSlot(squad.id, 'tests', holder, held.claim.id!)
  const promoted = await unsubscribeSlot(squad.id, 'tests', waiter, queued.waiter.id!)
  if (promoted.outcome !== 'already_granted') throw new Error('expected an already-granted waiter')
  expect(promoted.claimStatus).toBe('active')

  // Once that claim is released the waiter owes nothing, and unsubscribe must
  // stop telling it to release a claim that no longer exists.
  await releaseSlot(squad.id, 'tests', waiter, promoted.claimId)
  const settled = await unsubscribeSlot(squad.id, 'tests', waiter, queued.waiter.id!)
  if (settled.outcome !== 'already_granted') throw new Error('expected an already-granted waiter')
  expect(settled.claimStatus).toBe('released')
  expect(settled.message).toContain('nothing to release')
})

test('read projections use database time despite a skewed Core clock', async () => {
  const squad = await createSquad()
  const pool = await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
  const owner = await createAgent(squad.id)
  const granted = await claimSlot(squad.id, 'tests', owner)
  if (granted.outcome !== 'granted') throw new Error('bad fixture')
  await db
    .update(slotClaims)
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where(eq(slotClaims.id, granted.claim.id!))
  setSystemTime(new Date('2000-01-01T00:00:00Z'))

  await expect(getPool(squad.id, 'tests', { agentId: owner, diagnostics: false })).resolves.toMatchObject({
    id: pool.id,
    activeCount: 0,
    availableCount: 1,
  })
})

test('unregister expires overdue claims before checking whether the pool is busy', async () => {
  const squad = await createSquad()
  await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'agent:test' })
  const owner = await createAgent(squad.id)
  const granted = await claimSlot(squad.id, 'tests', owner)
  if (granted.outcome !== 'granted') throw new Error('bad fixture')
  await db
    .update(slotClaims)
    .set({ expiresAt: new Date(0) })
    .where(eq(slotClaims.id, granted.claim.id!))

  await expect(unregisterPool(squad.id, 'tests')).resolves.toMatchObject({ key: 'tests' })
})
