import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  agents,
  db,
  executionAdmissionReservations,
  executions,
  messages,
  squads,
  workStreamContinuations,
  workStreams,
} from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { reconcileDuplicateActiveExecutions } from './admission-reconciliation'
import { createPostgresConnection, getConnectionString } from '../../db/connection'
import { ADMISSION_LIVENESS_HASH_SEED, ADMISSION_LIVENESS_LOCK_VERSION } from '../maintenance/process-liveness'

const ownerConnection = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
afterAll(() => ownerConnection.end())

const seededAgentIds = new Set<string>()
const seededSquadIds = new Set<string>()

afterEach(async () => {
  const agentIds = [...seededAgentIds]
  if (agentIds.length) {
    const executionIds = (
      await db.select({ id: executions.id }).from(executions).where(inArray(executions.agentId, agentIds))
    ).map(({ id }) => id)
    await db.delete(workStreamContinuations).where(inArray(workStreamContinuations.assigneeAgentId, agentIds))
    await db.delete(workStreams).where(inArray(workStreams.assigneeAgentId, agentIds))
    await db.delete(messages).where(inArray(messages.agentId, agentIds))
    if (executionIds.length) {
      await db
        .delete(executionAdmissionReservations)
        .where(inArray(executionAdmissionReservations.executionId, executionIds))
      await db.delete(executions).where(inArray(executions.id, executionIds))
    }
    await db.delete(agents).where(inArray(agents.id, agentIds))
  }
  const squadIds = [...seededSquadIds]
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
  seededAgentIds.clear()
  seededSquadIds.clear()
})

describe('startup duplicate admission reconciliation', () => {
  async function seedAgent(status: 'queued' | 'running' = 'queued') {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'reconciliation-test' }).returning()
    seededAgentIds.add(agent.id)
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status }).returning()
    return { agent, execution }
  }

  async function seedExpiredNonterminalAdmission(executionId: string, agentId: string, ownerIncarnation: string) {
    await db.insert(executionAdmissionReservations).values({
      executionId,
      agentId,
      state: 'running',
      phase: 'none',
      token: crypto.randomUUID(),
      claimEpoch: 131n,
      ownerId: 'reconciliation-owner',
      ownerIncarnation,
      admittedGeneration: 137,
      admittedHolderRevision: 139n,
      leaseExpiresAt: new Date(0),
      lastHeartbeatAt: new Date(0),
    })
  }

  async function expectCanonicalQueuedAdmission(executionId: string, agentId: string) {
    const [row] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, executionId))
    expect(row).toMatchObject({
      executionId,
      agentId,
      state: 'queued',
      token: null,
      claimEpoch: null,
      ownerId: null,
      ownerIncarnation: null,
      admittedGeneration: null,
      admittedHolderRevision: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      phase: 'none',
      phaseSequence: 0,
      operationId: null,
      resourceKey: null,
      revokeGeneration: null,
      revokeHolderRevision: null,
      revokeAdminHold: null,
      revokeLeaseId: null,
      revokeLeaseOwnerTokenId: null,
      revokeRequestedAt: null,
      recoveryOwnerId: null,
      recoveryOwnerIncarnation: null,
    })
  }

  test('expired dead-owner queued admission is not valid canonical evidence', async () => {
    const { agent, execution } = await seedAgent()
    await seedExpiredNonterminalAdmission(execution.id, agent.id, crypto.randomUUID())

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(1)

    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe('queued')
    await expectCanonicalQueuedAdmission(execution.id, agent.id)
  })

  test('expired dead-owner admission cannot outrank durable stream evidence', async () => {
    const { agent, execution: stranded } = await seedAgent()
    const [streamOwner] = await db
      .insert(executions)
      .values({ agentId: agent.id, status: 'running', startedAt: new Date(Date.now() - 1_000) })
      .returning()
    await seedExpiredNonterminalAdmission(stranded.id, agent.id, crypto.randomUUID())
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'assistant',
      content: 'durable running output',
      metadata: { executionId: streamOwner.id, streamGroupId: `${streamOwner.id}:main` },
    })

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(1)

    const rows = await db.select().from(executions).where(eq(executions.agentId, agent.id))
    expect(rows.find(({ id }) => id === streamOwner.id)?.status).toBe('running')
    expect(rows.find(({ id }) => id === stranded.id)?.status).toBe('stopped')
    const current = await db
      .select()
      .from(executionAdmissionReservations)
      .where(
        and(
          eq(executionAdmissionReservations.agentId, agent.id),
          sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
        )
      )
    expect(current).toHaveLength(1)
    expect(current[0]?.executionId).toBe(streamOwner.id)
  })

  test('live-owner nonterminal admission remains valid canonical evidence', async () => {
    const { agent, execution } = await seedAgent()
    const ownerIncarnation = crypto.randomUUID()
    await ownerConnection`SELECT pg_advisory_lock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${ownerIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`
    try {
      await seedExpiredNonterminalAdmission(execution.id, agent.id, ownerIncarnation)
      const [executionBefore] = await db.select().from(executions).where(eq(executions.id, execution.id))
      const [reservationBefore] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))

      expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(0)

      const [executionAfter] = await db.select().from(executions).where(eq(executions.id, execution.id))
      const [reservationAfter] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(executionAfter).toEqual(executionBefore)
      expect(reservationAfter).toEqual(reservationBefore)
    } finally {
      await ownerConnection`SELECT pg_advisory_unlock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${ownerIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`
    }
  })

  test('terminal admission repair preserves canonical queued behavior', async () => {
    const { agent, execution } = await seedAgent()
    await db.insert(executionAdmissionReservations).values({
      executionId: execution.id,
      agentId: agent.id,
      state: 'revoked',
      phase: 'settlement',
      phaseSequence: 17,
      token: crypto.randomUUID(),
      claimEpoch: 149n,
      ownerId: 'terminal-owner',
      ownerIncarnation: crypto.randomUUID(),
      admittedGeneration: 151,
      admittedHolderRevision: 157n,
      leaseExpiresAt: new Date(0),
      lastHeartbeatAt: new Date(0),
      operationId: crypto.randomUUID(),
      resourceKey: 'terminal-resource',
      revokeGeneration: 163,
      revokeHolderRevision: 167n,
      revokeAdminHold: true,
      revokeLeaseId: crypto.randomUUID(),
      revokeLeaseOwnerTokenId: crypto.randomUUID(),
      revokeRequestedAt: new Date(0),
      recoveryOwnerId: 'old-recovery',
      recoveryOwnerIncarnation: crypto.randomUUID(),
    })

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(1)

    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe('queued')
    await expectCanonicalQueuedAdmission(execution.id, agent.id)
  })

  test('keeps the durable admission owner, preserves its status, and stops every nonowner', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'reconciliation-test' }).returning()
    seededAgentIds.add(agent.id)
    const base = Date.now() - 10_000
    const rows = await db
      .insert(executions)
      .values(
        Array.from({ length: 4 }, (_, index) => ({
          agentId: agent.id,
          status: 'running' as const,
          startedAt: new Date(base + index * 1_000),
        }))
      )
      .returning()
    const canonical = rows[2]!
    await db
      .insert(executionAdmissionReservations)
      .values({ executionId: canonical.id, agentId: agent.id, state: 'queued' })
    const [unrelatedAgent] = await db.insert(agents).values({ agentTypeId: 'reconciliation-test' }).returning()
    seededAgentIds.add(unrelatedAgent.id)
    const unrelatedRows = await db
      .insert(executions)
      .values([
        { agentId: unrelatedAgent.id, status: 'running' as const },
        { agentId: unrelatedAgent.id, status: 'running' as const },
      ])
      .returning()
    const stoppedEvents: string[] = []
    const updatedEvents: string[] = []
    const offStopped = eventEmitter.on('execution.stopped', ({ executionId }) => stoppedEvents.push(executionId))
    const offUpdated = eventEmitter.on('execution.updated', ({ executionId }) => updatedEvents.push(executionId))

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(3)
    offStopped()
    offUpdated()

    const after = await db.select().from(executions).where(eq(executions.agentId, agent.id))
    expect(after.find(({ id }) => id === canonical.id)?.status).toBe('running')
    expect(after.filter((execution) => execution.status === 'stopped')).toHaveLength(3)
    expect(stoppedEvents.sort()).toEqual(
      rows
        .filter(({ id }) => id !== canonical.id)
        .map(({ id }) => id)
        .sort()
    )
    expect(updatedEvents).toContain(canonical.id)
    const unrelatedAfter = await db
      .select({ id: executions.id, status: executions.status })
      .from(executions)
      .where(eq(executions.agentId, unrelatedAgent.id))
    expect(unrelatedAfter.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      unrelatedRows.map(({ id }) => ({ id, status: 'running' as const })).sort((a, b) => a.id.localeCompare(b.id))
    )
    expect(
      await db
        .select()
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.agentId, agent.id),
            sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
          )
        )
    ).toHaveLength(1)
  })

  test('prefers recent durable stream output when no active admission exists', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'reconciliation-test' }).returning()
    seededAgentIds.add(agent.id)
    const rows = await db
      .insert(executions)
      .values(
        Array.from({ length: 4 }, (_, index) => ({
          agentId: agent.id,
          status: 'running' as const,
          startedAt: new Date(Date.now() - 10_000 + index * 1_000),
        }))
      )
      .returning()
    const streamOwner = rows[2]!
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'assistant',
      content: 'durable SDK output',
      metadata: { executionId: streamOwner.id, streamGroupId: `${streamOwner.id}:main` },
    })

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(3)

    const after = await db.select().from(executions).where(eq(executions.agentId, agent.id))
    expect(after.find(({ id }) => id === streamOwner.id)?.status).toBe('running')
    expect(after.filter(({ status }) => status === 'stopped')).toHaveLength(3)
    const [admission] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    expect(admission?.executionId).toBe(streamOwner.id)
  })

  test('uses exact continuation delivery evidence when no admission or stream output exists', async () => {
    const [squad] = await db.insert(squads).values({ name: 'Reconciliation squad', purpose: 'test' }).returning()
    seededSquadIds.add(squad.id)
    const [agent] = await db
      .insert(agents)
      .values({ agentTypeId: 'reconciliation-test', squadId: squad.id })
      .returning()
    seededAgentIds.add(agent.id)
    const rows = await db
      .insert(executions)
      .values(
        Array.from({ length: 3 }, (_, index) => ({
          agentId: agent.id,
          status: 'running' as const,
          startedAt: new Date(Date.now() - 10_000 + index * 1_000),
        }))
      )
      .returning()
    const continuationOwner = rows[1]!
    const [workStream] = await db
      .insert(workStreams)
      .values({ squadId: squad.id, title: 'Continuation owner', assigneeAgentId: agent.id })
      .returning()
    await db.insert(workStreamContinuations).values({
      workStreamId: workStream.id,
      assigneeAgentId: agent.id,
      status: 'delivered',
      deliveryExecutionId: continuationOwner.id,
    })

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(2)

    const [admission] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    expect(admission?.executionId).toBe(continuationOwner.id)
  })

  test('repairs a single active legacy row with no admission', async () => {
    const [agent] = await db.insert(agents).values({ agentTypeId: 'reconciliation-test' }).returning()
    seededAgentIds.add(agent.id)
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'queued' }).returning()

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(1)

    const [admission] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    expect(admission).toMatchObject({ executionId: execution.id, state: 'queued' })
    expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]?.status).toBe('queued')
  })
})
