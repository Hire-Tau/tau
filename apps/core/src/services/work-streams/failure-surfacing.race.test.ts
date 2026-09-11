import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, like, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, inbox, squads, workStreamContinuations, workStreams } from '../../db/schema'
import { AgentType } from '../../entities/AgentType'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'
import { computeDerivedStates } from './derived-state'
import { notifyWorkStreamOwnersOfPlatformRefusal } from './platform-failure-notice'
import { reconcileWorkStreamContinuationsOnce } from './continuation'

/**
 * Race + recovery coverage for pre-tool failure surfacing: a refusal landing
 * while a newer execution is already running, the full refusal → re-admission
 * → completion recovery arc (derived state clearing, exactly one notice, no
 * duplicate execution effects), and continuation counters staying untouched.
 */
describe('failure surfacing race + recovery', () => {
  let testPrefix: string
  let squadId: string
  let ownerAgentId: string
  let assigneeAgentId: string
  let testAgentTypeId: string
  let streamId: string
  const createdAgentIds: string[] = []

  beforeEach(async () => {
    testPrefix = `race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Failure Race Test Type',
      systemPrompt: 'You are a test agent.',
    })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Squad`, purpose: 'failure race tests' })
      .returning()
    squadId = squad.id
    const owner = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    const assignee = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    ownerAgentId = owner.id
    assigneeAgentId = assignee.id
    createdAgentIds.push(ownerAgentId, assigneeAgentId)
    const stream = await storedLegacyWorkStream({
      squadId,
      title: `${testPrefix} stream`,
      assigneeAgentId,
      agentIds: [assigneeAgentId],
      ownerAgentId,
    })
    streamId = stream.id
    await db.delete(executions).where(eq(executions.agentId, assigneeAgentId))
    await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, assigneeAgentId))
  })

  afterEach(async () => {
    await db.delete(inbox).where(eq(inbox.recipientId, ownerAgentId))
    await db.delete(workStreamContinuations).where(eq(workStreamContinuations.workStreamId, streamId))
    await db.delete(workStreams).where(eq(workStreams.id, streamId))
    await db.delete(executions).where(inArray(executions.agentId, createdAgentIds))
    await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    createdAgentIds.length = 0
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  async function derivedInfo() {
    const fresh = await WorkStream.mustFind(streamId)
    return (await computeDerivedStates([fresh])).get(streamId)!
  }

  async function refusalNoticeCount() {
    const rows = await db
      .select({ id: inbox.id })
      .from(inbox)
      .where(
        sql`${inbox.metadata}->>'workStreamId' = ${streamId} and ${inbox.metadata}->>'source' = 'work-stream-platform-failure'`
      )
    return rows.length
  }

  test('a refusal landing while a newer execution is already running derives in_progress, not execution_failed', async () => {
    // The refusal happened first; re-admission already started a newer execution.
    await db.insert(executions).values({
      agentId: assigneeAgentId,
      status: 'failed',
      error: 'Admission effect was refused by the durable fence',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      endedAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 180_000),
    })
    const [running] = await db
      .insert(executions)
      .values({
        agentId: assigneeAgentId,
        status: 'running',
        startedAt: new Date(Date.now() - 60_000),
        runStartedAt: new Date(Date.now() - 59_000),
      })
      .returning()

    const info = await derivedInfo()
    expect(info.derivedState).toBe('in_progress')
    expect(info.terminalFailure).toBeUndefined()
    expect(running.status).toBe('running')
  })

  test('refusal → re-admission → completion: state clears, exactly one notice, old row untouched, counters clean', async () => {
    // Episode 1: the platform refusal.
    const [refused] = await db
      .insert(executions)
      .values({
        agentId: assigneeAgentId,
        status: 'failed',
        error: 'Admission effect was refused by the durable fence',
        failureClass: 'platform_pre_tool_refusal',
        failureReason: 'admission_fence-closed',
        endedAt: new Date(Date.now() - 180_000),
        startedAt: new Date(Date.now() - 240_000),
      })
      .returning()

    const failedInfo = await derivedInfo()
    expect(failedInfo.derivedState).toBe('execution_failed')
    expect(failedInfo.terminalFailure?.executionId).toBe(refused.id)

    // Exactly one owner notice across repeated events (restart replay).
    expect(await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: refused.id, agentId: assigneeAgentId })).toBe(1)
    expect(await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: refused.id, agentId: assigneeAgentId })).toBe(1)
    expect(await refusalNoticeCount()).toBe(1)

    // The continuation watchdog does not consume any budget on the refusal.
    await reconcileWorkStreamContinuationsOnce({ now: new Date(Date.now() - 170_000) })
    const [afterRefusalCycle] = await db
      .select()
      .from(workStreamContinuations)
      .where(eq(workStreamContinuations.workStreamId, streamId))
    if (afterRefusalCycle) {
      expect(afterRefusalCycle.status).toBe('idle')
      expect(afterRefusalCycle.normalAttemptCount).toBe(0)
      expect(afterRefusalCycle.transportAttemptCount).toBe(0)
      expect(afterRefusalCycle.triggerExecutionId).toBeNull()
    }

    // Episode 2: scheduler re-admission — a fresh execution (new claim epoch;
    // the refused row is untouched and terminal).
    const [resumed] = await db
      .insert(executions)
      .values({
        agentId: assigneeAgentId,
        status: 'running',
        startedAt: new Date(Date.now() - 120_000),
        runStartedAt: new Date(Date.now() - 119_000),
        runnerClaimToken: crypto.randomUUID(),
        runnerClaimGeneration: 1,
      })
      .returning()
    const runningInfo = await derivedInfo()
    expect(runningInfo.derivedState).toBe('in_progress')

    // Episode 3: the resumed execution completes — deterministic clearing.
    await db
      .update(executions)
      .set({ status: 'completed', endedAt: new Date(Date.now() - 60_000) })
      .where(eq(executions.id, resumed.id))
    const clearedInfo = await derivedInfo()
    expect(clearedInfo.derivedState).toBe('idle')
    expect(clearedInfo.terminalFailure).toBeUndefined()

    // No duplicate effects: the refused row kept its exact terminal state.
    const [refusedAfter] = await db.select().from(executions).where(eq(executions.id, refused.id))
    expect(refusedAfter.status).toBe('failed')
    expect(refusedAfter.failureClass).toBe('platform_pre_tool_refusal')
    expect(refusedAfter.failureReason).toBe('admission_fence-closed')
    expect(refusedAfter.error).toBe('Admission effect was refused by the durable fence')
    // And still exactly one notice for the whole episode arc.
    expect(await refusalNoticeCount()).toBe(1)
  })
})
