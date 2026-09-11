import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { describe, expect, test } from 'bun:test'
import { computeProvisionRecoveryTiming, deterministicRecoveryJitter } from './provision-recovery-store'

describe('sandbox provision recovery timing', () => {
  test('uses capped exponential backoff with stable bounded jitter', () => {
    const first = deterministicRecoveryJitter('00000000-0000-4000-8000-000000000001', 2, 3, 8_000)
    expect(first).toBe(deterministicRecoveryJitter('00000000-0000-4000-8000-000000000001', 2, 3, 8_000))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThanOrEqual(8_000)

    const now = new Date('2026-08-09T00:00:00Z')
    const timing = computeProvisionRecoveryTiming({
      executionId: '00000000-0000-4000-8000-000000000001',
      generation: 2,
      attemptCount: 20,
      retryAfterMs: 90_000,
      now,
      deadlineAt: new Date(now.getTime() + 70_000),
    })
    expect(timing.delayMs).toBe(70_000)
    expect(timing.nextAttemptAt).toEqual(new Date(now.getTime() + 70_000))
  })

  test('does not extend an existing deadline', () => {
    const now = new Date('2026-08-09T00:00:00Z')
    const deadlineAt = new Date(now.getTime() + 15_000)
    const first = computeProvisionRecoveryTiming({
      executionId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      attemptCount: 0,
      now,
      deadlineAt,
    })
    const expectedJitter = deterministicRecoveryJitter('00000000-0000-4000-8000-000000000001', 1, 0, 1_000)
    expect(first.nextAttemptAt).toEqual(new Date(now.getTime() + 5_000 + expectedJitter))
    expect(
      computeProvisionRecoveryTiming({
        executionId: '00000000-0000-4000-8000-000000000001',
        generation: 9,
        attemptCount: 9,
        now,
        deadlineAt,
      }).nextAttemptAt.getTime()
    ).toBe(deadlineAt.getTime())
  })
})

import { afterEach, beforeEach } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../../db'
import { agents, agentTypes, executions, k8sProvisionControls, sandboxProvisionRecoveries } from '../../../db/schema'
import { validateModelSpecList } from '../../../lib/utils/model-spec'
import { PostgresProvisionRecoveryStore, PROVISION_RECOVERY_BATCH_SIZE } from './provision-recovery-store'

const now = new Date('2026-08-09T01:00:00Z')
const TEST_MODEL = 'anthropic:claude-sonnet-4-5'
const EXPECTED_CLAIM_BATCH_LIMIT = 8
let agentId: string
let typeId: string
let scopePrefix: string
const createdScopes = new Set<string>()
const ownedExecutionIds = new Set<string>()
const neighborExecutionIds = new Set<string>()

function testScope(name: string): string {
  const scope = `${scopePrefix}-${name}`
  createdScopes.add(scope)
  return scope
}

beforeEach(async () => {
  createdScopes.clear()
  ownedExecutionIds.clear()
  neighborExecutionIds.clear()
  scopePrefix = crypto.randomUUID()
  typeId = `recovery-${crypto.randomUUID()}`
  await db.insert(agentTypes).values({ id: typeId, name: 'Recovery', model: TEST_MODEL, systemPrompt: 'test' })
  ;[{ id: agentId }] = await db.insert(agents).values({ agentTypeId: typeId }).returning({ id: agents.id })

  const [fixtureType] = await db.select({ model: agentTypes.model }).from(agentTypes).where(eq(agentTypes.id, typeId))
  expect(() => validateModelSpecList(fixtureType.model)).not.toThrow()
})

afterEach(async () => {
  if (ownedExecutionIds.size > 0) {
    await db
      .delete(sandboxProvisionRecoveries)
      .where(inArray(sandboxProvisionRecoveries.executionId, [...ownedExecutionIds]))
    await db.delete(executions).where(inArray(executions.id, [...ownedExecutionIds]))
  }
  if (neighborExecutionIds.size > 0) {
    expect(
      await db
        .select({ id: sandboxProvisionRecoveries.executionId })
        .from(sandboxProvisionRecoveries)
        .where(inArray(sandboxProvisionRecoveries.executionId, [...neighborExecutionIds]))
    ).toHaveLength(neighborExecutionIds.size)
    await db
      .delete(sandboxProvisionRecoveries)
      .where(inArray(sandboxProvisionRecoveries.executionId, [...neighborExecutionIds]))
    await db.delete(executions).where(inArray(executions.id, [...neighborExecutionIds]))
  }
  await db.delete(agents).where(eq(agents.id, agentId))
  if (createdScopes.size > 0) {
    await db.delete(k8sProvisionControls).where(inArray(k8sProvisionControls.scope, [...createdScopes]))
  }
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))

  expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))).toEqual([])
  expect(await db.select({ id: agentTypes.id }).from(agentTypes).where(eq(agentTypes.id, typeId))).toEqual([])
  expect(await db.select({ id: executions.id }).from(executions).where(eq(executions.agentId, agentId))).toEqual([])
  expect(
    await db
      .select({ id: sandboxProvisionRecoveries.executionId })
      .from(sandboxProvisionRecoveries)
      .where(eq(sandboxProvisionRecoveries.agentId, agentId))
  ).toEqual([])
})

async function seed(scope: string, sandboxKey: string, index: number, ownership: 'owned' | 'neighbor' = 'owned') {
  const [{ id: executionId }] = await db
    .insert(executions)
    .values({ agentId, status: 'waiting-sandbox', startedAt: new Date(now.getTime() - 10_000 + index) })
    .returning({ id: executions.id })
  if (ownership === 'owned') ownedExecutionIds.add(executionId)
  else neighborExecutionIds.add(executionId)
  await db.insert(sandboxProvisionRecoveries).values({
    executionId,
    agentId,
    scope,
    sandboxKey,
    refusalId: crypto.randomUUID(),
    status: 'waiting',
    errorCode: 'SANDBOX_PROVISION_BUSY',
    attemptCount: index % 2,
    nextAttemptAt: new Date(now.getTime() - 1_000),
    deadlineAt: new Date(now.getTime() + 60_000),
  })
  return executionId
}

async function seedDueNeighbor(name: string) {
  const scope = `neighbor-${crypto.randomUUID()}`
  createdScopes.add(scope)
  await db.insert(k8sProvisionControls).values({ scope, state: 'closed' })
  const executionId = await seed(scope, name, 10_000, 'neighbor')
  return { executionId, scope }
}

function ownedClaims<T extends { scope: string }>(claims: T[]): T[] {
  return claims.filter((claim) => claim.scope.startsWith(`${scopePrefix}-`))
}

describe('PostgresProvisionRecoveryStore claims', () => {
  test('leases a fixed fair batch with at most one candidate per sandbox', async () => {
    expect(PROVISION_RECOVERY_BATCH_SIZE).toBe(EXPECTED_CLAIM_BATCH_LIMIT)
    const closedScope = testScope('closed')
    await db.insert(k8sProvisionControls).values({ scope: closedScope, state: 'closed' })
    for (let index = 0; index < 12; index++) await seed(closedScope, `box-${Math.floor(index / 2)}`, index)
    const notDueId = await seed(closedScope, 'not-due', 100)
    const leasedId = await seed(closedScope, 'actively-leased', 101)
    const terminalId = await seed(closedScope, 'terminal', 102)
    await db
      .update(sandboxProvisionRecoveries)
      .set({ nextAttemptAt: new Date(now.getTime() + 60_000) })
      .where(eq(sandboxProvisionRecoveries.executionId, notDueId))
    await db
      .update(sandboxProvisionRecoveries)
      .set({ status: 'leased', leaseOwner: 'existing-owner', leaseExpiresAt: new Date(now.getTime() + 60_000) })
      .where(eq(sandboxProvisionRecoveries.executionId, leasedId))
    await db
      .update(sandboxProvisionRecoveries)
      .set({ status: 'exhausted' })
      .where(eq(sandboxProvisionRecoveries.executionId, terminalId))

    const premises = await db
      .select({
        executionId: sandboxProvisionRecoveries.executionId,
        status: sandboxProvisionRecoveries.status,
        nextAttemptAt: sandboxProvisionRecoveries.nextAttemptAt,
        leaseOwner: sandboxProvisionRecoveries.leaseOwner,
        leaseExpiresAt: sandboxProvisionRecoveries.leaseExpiresAt,
      })
      .from(sandboxProvisionRecoveries)
      .where(inArray(sandboxProvisionRecoveries.executionId, [notDueId, leasedId, terminalId]))
    expect(premises).toHaveLength(3)
    expect(premises.find((row) => row.executionId === notDueId)?.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime())
    expect(premises.find((row) => row.executionId === leasedId)).toMatchObject({
      status: 'leased',
      leaseOwner: 'existing-owner',
    })
    expect(premises.find((row) => row.executionId === leasedId)?.leaseExpiresAt?.getTime()).toBeGreaterThan(
      now.getTime()
    )
    expect(premises.find((row) => row.executionId === terminalId)?.status).toBe('exhausted')

    const neighbor = await seedDueNeighbor('unrelated-due')
    const claims = await new PostgresProvisionRecoveryStore().claimDue('worker', now)
    const owned = ownedClaims(claims)

    expect(claims.some((claim) => claim.executionId === neighbor.executionId)).toBe(true)
    expect(claims.some((claim) => [notDueId, leasedId, terminalId].includes(claim.executionId))).toBe(false)
    expect(owned).toHaveLength(6)
    expect(claims.length).toBeLessThanOrEqual(EXPECTED_CLAIM_BATCH_LIMIT)
    expect(new Set(owned.map((claim) => claim.sandboxKey)).size).toBe(owned.length)
    expect(owned.every((claim) => claim.claimKind === 'ordinary')).toBe(true)

    const blockedSiblings = await new PostgresProvisionRecoveryStore().claimDue('other-worker', now)
    expect(ownedClaims(blockedSiblings)).toHaveLength(0)
  })

  test('SKIP LOCKED does not wait behind another recovery owner', async () => {
    const lockedScope = testScope('locked')
    await db.insert(k8sProvisionControls).values({ scope: lockedScope, state: 'closed' })
    const executionId = await seed(lockedScope, 'box', 0)
    const neighbor = await seedDueNeighbor('skip-locked-neighbor')
    let release!: () => void
    let locked!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const acquired = new Promise<void>((resolve) => (locked = resolve))
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, executionId))
        .for('update')
      locked()
      await released
    })
    await acquired

    try {
      const claims = await Promise.race([
        new PostgresProvisionRecoveryStore().claimDue('other', now),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('claim waited on locked row')), 500)),
      ])
      expect(ownedClaims(claims)).toHaveLength(0)
      expect(claims.some((claim) => claim.executionId === neighbor.executionId)).toBe(true)
    } finally {
      release()
      await holder
    }
  })

  test('leases one open-scope probe, none during half-open, and deduplicates concurrent owners', async () => {
    const openScope = testScope('open')
    const halfScope = testScope('half')
    await db.insert(k8sProvisionControls).values({ scope: openScope, state: 'open', retryAt: now })
    await db.insert(k8sProvisionControls).values({ scope: halfScope, state: 'half_open' })
    for (let index = 0; index < 4; index++) {
      await seed(openScope, `open-${index}`, index)
      await seed(halfScope, `half-${index}`, index)
    }

    const neighbor = await seedDueNeighbor('concurrent-neighbor')
    const [left, right] = await Promise.all([
      new PostgresProvisionRecoveryStore().claimDue('left', now),
      new PostgresProvisionRecoveryStore().claimDue('right', now),
    ])
    const claims = [...left, ...right]
    expect(claims.some((claim) => claim.executionId === neighbor.executionId)).toBe(true)
    expect(claims.filter((claim) => claim.scope === openScope)).toHaveLength(1)
    expect(claims.find((claim) => claim.scope === openScope)?.claimKind).toBe('half_open_probe')
    expect(claims.some((claim) => claim.scope === halfScope)).toBe(false)
    expect(new Set(claims.map((claim) => claim.executionId)).size).toBe(claims.length)
  })
})

describe('PostgresProvisionRecoveryStore load bounds', () => {
  test('leases 100 waiters in bounded fair duplicate-free batches across concurrent reconcilers', async () => {
    const loadAScope = testScope('load-a')
    const loadBScope = testScope('load-b')
    await db.insert(k8sProvisionControls).values([
      { scope: loadAScope, state: 'closed' },
      { scope: loadBScope, state: 'closed' },
    ])
    for (let index = 0; index < 100; index++) {
      await seed(index % 2 ? loadAScope : loadBScope, `box-${index % 10}`, index)
    }
    const neighbor = await seedDueNeighbor('load-neighbor')
    let claimedNeighbor = false

    const seen = new Set<string>()
    const firstServedSweep = new Map<string, number>()
    let sweep = 0
    while (seen.size < 100 && sweep++ < 30) {
      const batches = await Promise.all([
        new PostgresProvisionRecoveryStore().claimDue(`left-${sweep}`, now),
        new PostgresProvisionRecoveryStore().claimDue(`right-${sweep}`, now),
      ])
      claimedNeighbor ||= batches.flat().some((claim) => claim.executionId === neighbor.executionId)
      for (const globalBatch of batches) {
        const batch = ownedClaims(globalBatch)
        expect(globalBatch.length).toBeLessThanOrEqual(EXPECTED_CLAIM_BATCH_LIMIT)
        expect(new Set(batch.map((claim) => `${claim.scope}:${claim.sandboxKey}`)).size).toBe(batch.length)
        for (const claim of batch) {
          expect(seen.has(claim.executionId)).toBe(false)
          seen.add(claim.executionId)
          const sandbox = `${claim.scope}:${claim.sandboxKey}`
          if (!firstServedSweep.has(sandbox)) firstServedSweep.set(sandbox, sweep)
        }
      }
      const ids = ownedClaims(batches.flat()).map((claim) => claim.executionId)
      if (ids.length) {
        await db
          .update(sandboxProvisionRecoveries)
          .set({ status: 'resumed', leaseOwner: null, leaseExpiresAt: null, claimKind: null })
          .where(inArray(sandboxProvisionRecoveries.executionId, ids))
      }
    }

    expect(claimedNeighbor).toBe(true)
    expect(seen.size).toBe(100)
    expect(firstServedSweep.size).toBe(10)
    expect(Math.max(...firstServedSweep.values())).toBeLessThanOrEqual(2)
    expect(new Set([...firstServedSweep.keys()].map((key) => key.split(':')[0]))).toEqual(
      new Set([loadAScope, loadBScope])
    )
  })
})
