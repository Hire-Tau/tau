import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, executionAdmissionReservations, executions, sandboxProvisionRecoveries, squads } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { ACTIVE_EXECUTION_STATUSES } from './status'
import {
  settleExecutionForRemovedAgent,
  settleExecutionsForRemovedAgent,
  settleOrphanedExecutionsOnce,
} from './orphan-settlement'

/**
 * Belt-and-braces settlement for executions whose owning agent can no longer
 * run them: the agent row is gone (unspawn/delete raced a queue write, or an
 * FK-bypassed restore left orphans) or the agent is terminated. See
 * ./orphan-settlement.ts for the full contract.
 */

describe('orphaned execution settlement', () => {
  let ownedSquadIds: string[]
  let ownedAgentIds: string[]
  let ownedExecutionIds: string[]

  beforeEach(() => {
    ownedSquadIds = []
    ownedAgentIds = []
    ownedExecutionIds = []
  })

  afterEach(async () => {
    // Hard-deleted-agent fixtures leave execution rows with no cascade
    // target, so executions are removed explicitly by id.
    if (ownedExecutionIds.length) {
      await db.delete(executions).where(inArray(executions.id, ownedExecutionIds))
    }
    if (ownedAgentIds.length) {
      // Orphan fixtures may already have their agent rows force-deleted; the
      // delete simply matches nothing then.
      await db.delete(agents).where(inArray(agents.id, ownedAgentIds))
    }
    if (ownedSquadIds.length) await db.delete(squads).where(inArray(squads.id, ownedSquadIds))
  })

  async function createAgent(input: { status?: 'idle' | 'dormant' | 'terminated'; startedAt?: Date }): Promise<string> {
    const squadId = crypto.randomUUID()
    const agentId = crypto.randomUUID()
    ownedSquadIds.push(squadId)
    ownedAgentIds.push(agentId)
    await db.insert(squads).values({
      id: squadId,
      name: `orphan-settle-${squadId}`,
      purpose: 'orphan settlement test',
    })
    await db.insert(agents).values({
      id: agentId,
      agentTypeId: 'engineer',
      squadId,
      status: input.status ?? 'idle',
      ...(input.status === 'terminated' ? { terminatedAt: input.startedAt ?? new Date() } : {}),
      ...(input.status === 'dormant' ? { dormantAt: input.startedAt ?? new Date() } : {}),
    })
    return agentId
  }

  async function insertActiveExecution(input: {
    agentId: string
    status?: (typeof ACTIVE_EXECUTION_STATUSES)[number]
    startedAt?: Date
    /** Only the first execution per agent carries a reservation (the one-current-reservation-per-agent invariant). */
    withReservation?: boolean
  }): Promise<string> {
    const status = input.status ?? 'queued'
    const [row] = await db
      .insert(executions)
      .values({
        agentId: input.agentId,
        status,
        startedAt: input.startedAt ?? new Date(),
        message: 'orphan-settlement fixture',
      })
      .returning({ id: executions.id })
    ownedExecutionIds.push(row!.id)
    if (input.withReservation !== false) {
      await db.insert(executionAdmissionReservations).values({
        agentId: input.agentId,
        executionId: row!.id,
        state: status === 'waiting-maintenance' ? 'waiting-maintenance' : 'queued',
      })
    }
    return row!.id
  }

  /** FK-bypassed agent removal: the executions row must survive the delete. */
  async function hardDeleteAgentRow(agentId: string): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.delete(agents).where(eq(agents.id, agentId))
    })
  }

  const executionRow = async (executionId: string) =>
    (await db.select().from(executions).where(eq(executions.id, executionId)).limit(1))[0]

  const settledOrphans = async () =>
    db
      .select({ id: executions.id })
      .from(executions)
      .where(sql`${executions.status} = 'failed' AND ${executions.failureReason} = 'agent_removed'`)

  describe('settleExecutionForRemovedAgent', () => {
    test('terminal-settles a never-started execution of a terminated agent as execution_failure/agent_removed', async () => {
      const agentId = await createAgent({ status: 'terminated' })
      const executionId = await insertActiveExecution({ agentId })

      expect(await settleExecutionForRemovedAgent(executionId)).toBe('settled')

      const row = await executionRow(executionId)
      expect(row).toMatchObject({
        status: 'failed',
        failureClass: 'execution_failure',
        failureReason: 'agent_removed',
      })
      expect(row!.endedAt).toBeInstanceOf(Date)
      expect(row!.runStartedAt).toBeNull()
      // Readable prose for the chat/UI; never parsed back out.
      expect(row!.error).toContain('removed')
    })

    test('settles an execution whose agent row no longer exists', async () => {
      const agentId = await createAgent({ status: 'idle' })
      const executionId = await insertActiveExecution({ agentId })
      await hardDeleteAgentRow(agentId)

      expect(await settleExecutionForRemovedAgent(executionId)).toBe('settled')
      expect(await executionRow(executionId)).toMatchObject({
        status: 'failed',
        failureReason: 'agent_removed',
      })
    })

    test('never writes the agent row: the terminated agent stays terminated', async () => {
      const agentId = await createAgent({ status: 'terminated' })
      const executionId = await insertActiveExecution({ agentId })

      await settleExecutionForRemovedAgent(executionId)

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
      expect(agent?.status).toBe('terminated')
    })

    test('releases the queue-owned admission reservation and cancels a waiting sandbox recovery', async () => {
      const agentId = await createAgent({ status: 'terminated' })
      const executionId = await insertActiveExecution({ agentId, status: 'waiting-sandbox' })
      await db.insert(sandboxProvisionRecoveries).values({
        executionId,
        agentId,
        scope: 'agent',
        sandboxKey: `agent_${agentId}`,
        refusalId: crypto.randomUUID(),
        status: 'waiting',
        errorCode: 'SANDBOX_PROVISION_UNAVAILABLE',
        nextAttemptAt: new Date(),
        deadlineAt: new Date(Date.now() + 60 * 60_000),
      })

      expect(await settleExecutionForRemovedAgent(executionId)).toBe('settled')

      const [reservation] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, executionId))
        .limit(1)
      expect(reservation?.state).toBe('released')
      const [recovery] = await db
        .select({ status: sandboxProvisionRecoveries.status })
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, executionId))
        .limit(1)
      expect(recovery?.status).toBe('cancelled')
    })

    test('emits execution.updated and execution.failed with the classification after commit', async () => {
      const agentId = await createAgent({ status: 'terminated' })
      const executionId = await insertActiveExecution({ agentId })

      const emitted: Array<{ event: string; payload: Record<string, unknown> }> = []
      const unsubscribeUpdated = eventEmitter.on('execution.updated', (payload) => {
        emitted.push({ event: 'execution.updated', payload: payload as unknown as Record<string, unknown> })
      })
      const unsubscribeFailed = eventEmitter.on('execution.failed', (payload) => {
        emitted.push({ event: 'execution.failed', payload: payload as unknown as Record<string, unknown> })
      })
      try {
        await settleExecutionForRemovedAgent(executionId)
      } finally {
        unsubscribeUpdated()
        unsubscribeFailed()
      }

      expect(emitted).toEqual([
        {
          event: 'execution.updated',
          payload: { executionId, agentId, status: 'failed' },
        },
        {
          event: 'execution.failed',
          payload: {
            executionId,
            agentId,
            status: 'failed',
            failureClass: 'execution_failure',
            failureReason: 'agent_removed',
          },
        },
      ])
    })

    test('refuses to settle an execution whose agent is live, and one whose agent is dormant', async () => {
      const liveAgentId = await createAgent({ status: 'idle' })
      const liveExecutionId = await insertActiveExecution({ agentId: liveAgentId })
      const dormantAgentId = await createAgent({ status: 'dormant' })
      const dormantExecutionId = await insertActiveExecution({ agentId: dormantAgentId })

      expect(await settleExecutionForRemovedAgent(liveExecutionId)).toBe('agent-live')
      expect(await settleExecutionForRemovedAgent(dormantExecutionId)).toBe('agent-live')

      // Dormant agents can still be woken by pickup to serve queued work, so
      // their demand is genuine — the rows must stay exactly as they were.
      expect((await executionRow(liveExecutionId))?.status).toBe('queued')
      expect((await executionRow(dormantExecutionId))?.status).toBe('queued')
    })

    test('leaves already-terminal executions untouched (idempotent CAS)', async () => {
      const agentId = await createAgent({ status: 'terminated' })
      const executionId = await insertActiveExecution({ agentId })
      await settleExecutionForRemovedAgent(executionId)

      expect(await settleExecutionForRemovedAgent(executionId)).toBe('not-active')

      const row = await executionRow(executionId)
      expect(row?.status).toBe('failed')
      expect(row?.endedAt).toBeInstanceOf(Date)
    })
  })

  describe('settleExecutionsForRemovedAgent', () => {
    test('settles every non-terminal execution of the terminated agent and nothing else', async () => {
      const terminatedAgentId = await createAgent({ status: 'terminated' })
      const settledIds: string[] = []
      let index = 0
      for (const status of ACTIVE_EXECUTION_STATUSES) {
        // Only the invariant-shaped first row carries the agent's reservation.
        settledIds.push(
          await insertActiveExecution({ agentId: terminatedAgentId, status, withReservation: index++ === 0 })
        )
      }
      const terminalId = await insertActiveExecution({ agentId: terminatedAgentId, withReservation: false })
      await db.update(executions).set({ status: 'completed', endedAt: new Date() }).where(eq(executions.id, terminalId))

      const liveAgentId = await createAgent({ status: 'idle' })
      const liveExecutionId = await insertActiveExecution({ agentId: liveAgentId })

      expect(await settleExecutionsForRemovedAgent(terminatedAgentId)).toBe(ACTIVE_EXECUTION_STATUSES.length)

      for (const executionId of settledIds) {
        expect(await executionRow(executionId)).toMatchObject({ status: 'failed', failureReason: 'agent_removed' })
      }
      expect((await executionRow(terminalId))?.status).toBe('completed')
      expect((await executionRow(liveExecutionId))?.status).toBe('queued')
      expect(await settleExecutionsForRemovedAgent(liveAgentId)).toBe(0)
      expect((await executionRow(liveExecutionId))?.status).toBe('queued')
    })
  })

  describe('settleOrphanedExecutionsOnce (startup reconciliation)', () => {
    beforeEach(async () => {
      // Other suites legitimately leave non-terminal rows behind once their
      // squads are deleted — inert for demand, but live candidates for this
      // sweep. Clear the candidate set so exact-count assertions stay
      // deterministic.
      await db.delete(executions).where(inArray(executions.status, [...ACTIVE_EXECUTION_STATUSES]))
    })

    test('settles the incident shape: queued executions whose agent rows no longer exist', async () => {
      const agentId = await createAgent({ status: 'idle' })
      const orphanExecutionId = await insertActiveExecution({ agentId })
      await hardDeleteAgentRow(agentId)

      expect(await settleOrphanedExecutionsOnce()).toBe(1)
      expect(await executionRow(orphanExecutionId)).toMatchObject({
        status: 'failed',
        failureReason: 'agent_removed',
      })
    })

    test('settles never-started executions of terminated agents but never touches live or dormant agents', async () => {
      const terminatedAgentId = await createAgent({ status: 'terminated' })
      const terminatedExecutionId = await insertActiveExecution({ agentId: terminatedAgentId })
      const liveAgentId = await createAgent({ status: 'idle' })
      const liveExecutionId = await insertActiveExecution({ agentId: liveAgentId })
      const dormantAgentId = await createAgent({ status: 'dormant' })
      const dormantExecutionId = await insertActiveExecution({ agentId: dormantAgentId })

      expect(await settleOrphanedExecutionsOnce()).toBeGreaterThanOrEqual(1)
      expect(await executionRow(terminatedExecutionId)).toMatchObject({
        status: 'failed',
        failureReason: 'agent_removed',
      })
      expect((await executionRow(liveExecutionId))?.status).toBe('queued')
      expect((await executionRow(dormantExecutionId))?.status).toBe('queued')
    })

    test('is idempotent: a second sweep settles nothing', async () => {
      const agentId = await createAgent({ status: 'terminated' })
      await insertActiveExecution({ agentId })

      const first = await settleOrphanedExecutionsOnce()
      expect(first).toBeGreaterThanOrEqual(1)
      expect(await settleOrphanedExecutionsOnce()).toBe(0)
    })

    test('is bounded: maxCandidates settles only the oldest orphans', async () => {
      const base = Date.now() - 60 * 60_000
      const agentIds: string[] = []
      const executionIds: string[] = []
      for (let index = 0; index < 3; index++) {
        const agentId = await createAgent({ status: 'terminated' })
        agentIds.push(agentId)
        executionIds.push(await insertActiveExecution({ agentId, startedAt: new Date(base + index * 60_000) }))
      }

      expect(await settleOrphanedExecutionsOnce({ maxCandidates: 2 })).toBe(2)

      expect(await executionRow(executionIds[0]!)).toMatchObject({ status: 'failed' })
      expect(await executionRow(executionIds[1]!)).toMatchObject({ status: 'failed' })
      expect((await executionRow(executionIds[2]!))?.status).toBe('queued')
    })

    test('is safe under concurrent sweeps: each orphan settles exactly once', async () => {
      const agentIds: string[] = []
      for (let index = 0; index < 4; index++) {
        const agentId = await createAgent({ status: 'terminated' })
        agentIds.push(agentId)
        await insertActiveExecution({ agentId })
      }

      const [first, second] = await Promise.all([settleOrphanedExecutionsOnce(), settleOrphanedExecutionsOnce()])

      expect(first + second).toBe(agentIds.length)
      expect((await settledOrphans()).length).toBeGreaterThanOrEqual(agentIds.length)
      for (const agentId of agentIds) {
        const rows = await db
          .select({ id: executions.id, status: executions.status, endedAt: executions.endedAt })
          .from(executions)
          .where(eq(executions.agentId, agentId))
        expect(rows).toHaveLength(1)
        expect(rows[0]?.status).toBe('failed')
        expect(rows[0]?.endedAt).toBeInstanceOf(Date)
      }
    })
  })
})
