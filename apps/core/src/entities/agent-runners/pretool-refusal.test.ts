import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { executions, agents, agentTypes, executionAdmissionReservations, messages, squads } from '../../db/schema'
import { AgentType } from '../AgentType'
import { Agent } from '../Agent'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { attemptPickup } from '../../services/execution/pickup'
import { MockAgentSession } from '../../services/execution/test-helpers'
import { SquadWorkerRunner } from './squad-worker-runner'
import { MaintenanceStore } from '../../services/maintenance/store'
import { maintenanceStore } from '../../services/maintenance'
import { concurrencyLimiter } from '../../services/execution/concurrency-limiter-instance'
import { isSessionActive, removeSession } from '../../services/execution/session-state'
import { executionLifecycleRegistry } from '../../services/execution/lifecycle-registry'

/**
 * Deterministic reproduction of the production incident: the durable fence
 * refuses an admission effect AFTER the queued→running claim but BEFORE any
 * model output, and the failed execution must carry the structural
 * platform_pre_tool_refusal classification — not just prose — so the stream
 * can never display as ordinary idle.
 *
 * The fence is unweakened: the refusal is produced by the real
 * beginWritePhaseDetailed revocation path (admin hold closes the fence after
 * the claim, exactly like a maintenance pause landing mid-setup).
 */
describe('pre-tool admission refusal classification (deterministic)', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let squadId: string
  let agent: Agent
  let createSessionSpy: ReturnType<typeof spyOn> | undefined
  const createdExecutionIds: string[] = []

  beforeEach(async () => {
    await maintenanceStore.refresh()
    testPrefix = `pretool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'zai:glm-5.2',
      name: 'Pre-tool Refusal Worker',
      systemPrompt: 'You are a test agent.',
    })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Squad`, purpose: 'pre-tool refusal reproduction' })
      .returning()
    squadId = squad.id
    agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
  })

  afterEach(async () => {
    createSessionSpy?.mockRestore()
    createSessionSpy = undefined
    for (const executionId of createdExecutionIds.splice(0)) {
      concurrencyLimiter.release(executionId)
      executionLifecycleRegistry.get(executionId)?.settle()
    }
    concurrencyLimiter.reset()
    if (isSessionActive(agent.id)) removeSession(agent.id)
    if (createdExecutionIds.length > 0) {
      await db
        .delete(executionAdmissionReservations)
        .where(inArray(executionAdmissionReservations.executionId, createdExecutionIds))
    }
    await db.delete(messages).where(eq(messages.agentId, agent.id))
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await new MaintenanceStore().setAdminHold({ active: false, actor: 'test' }).catch(() => {})
  })

  test('a fenced pre-tool refusal durably classifies the execution and idles the agent', async () => {
    // Close the fence deterministically BETWEEN the claim and the first
    // admission effect: createSession runs before createPiSession's
    // session-create effect, so the admin hold lands after the runner holds
    // its lease but before beginWritePhase.
    createSessionSpy = spyOn(
      SquadWorkerRunner.prototype as never as {
        createSession: (scope?: unknown) => Promise<unknown>
      },
      'createSession'
    ).mockImplementation(async function (
      this: { createPiSession: (scope: unknown, create: () => Promise<unknown>) => Promise<unknown> },
      scope?: unknown
    ) {
      await new MaintenanceStore().setAdminHold({ active: true, actor: 'test' })
      return this.createPiSession(scope ?? null, () => Promise.resolve(new MockAgentSession()))
    })

    const execution = await agent.queueExecution({ message: 'will be refused by the fence' })
    createdExecutionIds.push(execution.id)

    const failedPayloads: Array<Record<string, unknown>> = []
    const unsub = eventEmitter.on('execution.failed', (payload) => {
      if (payload.executionId === execution.id) failedPayloads.push(payload as Record<string, unknown>)
    })

    try {
      expect(await attemptPickup(execution)).toBe('started')

      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const [row] = await db.select().from(executions).where(eq(executions.id, execution.id))
        if (row?.status === 'failed') break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const [row] = await db.select().from(executions).where(eq(executions.id, execution.id))
      expect(row.status).toBe('failed')
      expect(row.failureClass).toBe('platform_pre_tool_refusal')
      expect(row.failureReason).toBe('admission_fence-closed')
      // The prose is byte-identical to the production incident.
      expect(row.error).toBe('Admission effect was refused by the durable fence')
      expect(row.endedAt).toBeTruthy()

      // Agent went idle (the incident's silent-idle symptom) — but now the row
      // itself carries the structural classification.
      const [agentRow] = await db.select().from(agents).where(eq(agents.id, agent.id))
      expect(agentRow.status).toBe('idle')

      // No model output: the only assistant rows are the failure system message;
      // the human row is the queued prompt itself.
      const rows = await db.select().from(messages).where(eq(messages.agentId, agent.id))
      const assistantRows = rows.filter((row) => row.role === 'assistant')
      expect(assistantRows.length).toBe(1)
      expect(assistantRows[0].content.startsWith('[System] Execution failed:')).toBe(true)

      // The fenced lease settled terminally (fence guarantees preserved).
      const [reservation] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(['released', 'revoked']).toContain(reservation.state)

      // The event payload carries the classification additively.
      expect(failedPayloads.length).toBe(1)
      expect(failedPayloads[0]).toMatchObject({
        executionId: execution.id,
        status: 'failed',
        failureClass: 'platform_pre_tool_refusal',
        failureReason: 'admission_fence-closed',
      })
    } finally {
      unsub()
    }
  })

  test('a database connection failure during real runner setup requeues without a failure message', async () => {
    createSessionSpy = spyOn(
      SquadWorkerRunner.prototype as unknown as { createSession: () => Promise<unknown> },
      'createSession'
    ).mockRejectedValue(Object.assign(new Error('too many connections for role "test_tenant"'), { code: '53300' }))
    const execution = await agent.queueExecution({ message: 'retry this startup' })
    createdExecutionIds.push(execution.id)
    expect(await attemptPickup(execution)).toBe('started')
    await executionLifecycleRegistry.get(execution.id)?.runnerFinished
    await execution.reload()
    expect(execution.status).toBe('queued')
    expect(execution.startupRetryCount).toBe(1)
    expect(execution.startupRetryAt).toBeInstanceOf(Date)
    const rows = await db.select().from(messages).where(eq(messages.agentId, agent.id))
    expect(rows.some((row) => row.content.includes('[System] Execution failed:'))).toBe(false)
    expect(await attemptPickup(execution)).toBe('not-queued')
  })
})
