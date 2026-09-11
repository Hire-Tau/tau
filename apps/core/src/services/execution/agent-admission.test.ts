import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agents, db, executionAdmissionReservations, executions } from '../../db'
import {
  acquireAgentQueueLock,
  createQueuedAdmission,
  loadCurrentAdmission,
  releaseExactAdmission,
  restoreQueueOwnedAdmission,
} from './agent-admission'

afterEach(async () => {
  await db.delete(executionAdmissionReservations)
  await db.delete(executions)
  await db.delete(agents)
})

async function createAgentWithExecutions(count: number) {
  const [agent] = await db.insert(agents).values({ agentTypeId: 'admission-test' }).returning()
  const rows = await db
    .insert(executions)
    .values(Array.from({ length: count }, () => ({ agentId: agent.id, status: 'queued' as const })))
    .returning()
  return { agent, rows }
}

describe('agent execution admission', () => {
  test('allows only one current queued admission for an agent', async () => {
    const { agent, rows } = await createAgentWithExecutions(2)

    const results = await Promise.allSettled(
      rows.map((execution) =>
        db.transaction(async (tx) => {
          await acquireAgentQueueLock(tx, agent.id)
          return createQueuedAdmission(tx, {
            agentId: agent.id,
            executionId: execution.id,
            state: 'queued',
          })
        })
      )
    )

    const reservations = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.agentId, agent.id))
    expect(reservations).toHaveLength(1)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(reservations[0]).toMatchObject({ agentId: agent.id, state: 'queued', token: null, ownerId: null })
  })

  test('releasing the exact queued owner permits a successor', async () => {
    const { agent, rows } = await createAgentWithExecutions(2)

    await db.transaction(async (tx) => {
      await acquireAgentQueueLock(tx, agent.id)
      await createQueuedAdmission(tx, { agentId: agent.id, executionId: rows[0]!.id, state: 'queued' })
      expect(await releaseExactAdmission(tx, agent.id, rows[0]!.id)).toBe(true)
      await createQueuedAdmission(tx, { agentId: agent.id, executionId: rows[1]!.id, state: 'queued' })
    })

    const current = await db.transaction(async (tx) => {
      await acquireAgentQueueLock(tx, agent.id)
      return loadCurrentAdmission(tx, agent.id)
    })
    expect(current).toMatchObject({ executionId: rows[1]!.id, state: 'queued' })
  })

  test('restore clears the complete lease and effect field set', async () => {
    const { agent, rows } = await createAgentWithExecutions(1)
    const execution = rows[0]!
    const expectedLease = {
      token: crypto.randomUUID(),
      claimEpoch: 17n,
      ownerId: 'worker-17',
      ownerIncarnation: crypto.randomUUID(),
      admittedGeneration: 23,
      admittedHolderRevision: 29n,
    }
    await db.insert(executionAdmissionReservations).values({
      executionId: execution.id,
      agentId: agent.id,
      state: 'running',
      phase: 'settlement',
      phaseSequence: 9,
      operationId: crypto.randomUUID(),
      resourceKey: 'dirty-resource',
      leaseExpiresAt: new Date(0),
      lastHeartbeatAt: new Date(0),
      revokeGeneration: 31,
      revokeHolderRevision: 37n,
      revokeAdminHold: true,
      revokeLeaseId: crypto.randomUUID(),
      revokeLeaseOwnerTokenId: crypto.randomUUID(),
      revokeRequestedAt: new Date(0),
      recoveryOwnerId: 'recovery-worker',
      recoveryOwnerIncarnation: crypto.randomUUID(),
      ...expectedLease,
    })

    expect(
      await db.transaction((tx) =>
        restoreQueueOwnedAdmission(tx, { agentId: agent.id, executionId: execution.id, expectedLease })
      )
    ).toBe(true)
    const [restored] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(restored).toMatchObject({
      executionId: execution.id,
      agentId: agent.id,
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
  })

  for (const field of [
    'token',
    'claimEpoch',
    'ownerId',
    'ownerIncarnation',
    'admittedGeneration',
    'admittedHolderRevision',
  ] as const) {
    test(`restore exact CAS rejects changed ${field}`, async () => {
      const { agent, rows } = await createAgentWithExecutions(1)
      const execution = rows[0]!
      const expectedLease = {
        token: crypto.randomUUID(),
        claimEpoch: 41n,
        ownerId: 'worker-41',
        ownerIncarnation: crypto.randomUUID(),
        admittedGeneration: 43,
        admittedHolderRevision: 47n,
      }
      await db.insert(executionAdmissionReservations).values({
        executionId: execution.id,
        agentId: agent.id,
        state: 'running',
        phase: 'none',
        leaseExpiresAt: new Date(0),
        lastHeartbeatAt: new Date(0),
        ...expectedLease,
      })
      const changed = {
        token: crypto.randomUUID(),
        claimEpoch: 53n,
        ownerId: 'worker-53',
        ownerIncarnation: crypto.randomUUID(),
        admittedGeneration: 59,
        admittedHolderRevision: 61n,
      }[field]
      await db
        .update(executionAdmissionReservations)
        .set({ [field]: changed })
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      const [before] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))

      expect(
        await db.transaction((tx) =>
          restoreQueueOwnedAdmission(tx, { agentId: agent.id, executionId: execution.id, expectedLease })
        )
      ).toBe(false)
      const [after] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(after).toEqual(before)
    })
  }

  test('a stale execution cannot release its successor', async () => {
    const { agent, rows } = await createAgentWithExecutions(2)

    await db.transaction(async (tx) => {
      await acquireAgentQueueLock(tx, agent.id)
      await createQueuedAdmission(tx, { agentId: agent.id, executionId: rows[0]!.id, state: 'queued' })
      await releaseExactAdmission(tx, agent.id, rows[0]!.id)
      await createQueuedAdmission(tx, { agentId: agent.id, executionId: rows[1]!.id, state: 'queued' })
      expect(await releaseExactAdmission(tx, agent.id, rows[0]!.id)).toBe(false)
    })

    const [successor] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, rows[1]!.id))
    expect(successor.state).toBe('queued')
  })
})
