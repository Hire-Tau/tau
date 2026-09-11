import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, like } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, inbox, squads, workStreams, workStreamWaits } from '../../db/schema'
import { AgentType } from '../../entities/AgentType'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'
import { notifyWorkStreamOwnersOfPlatformRefusal } from './platform-failure-notice'

describe('work-stream platform failure notice', () => {
  let testPrefix: string
  let squadId: string
  let ownerAgentId: string
  let assigneeAgentId: string
  let testAgentTypeId: string
  const createdStreamIds: string[] = []
  const createdAgentIds: string[] = []

  beforeEach(async () => {
    testPrefix = `wsfail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Platform Failure Test Type',
      systemPrompt: 'You are a test agent.',
    })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Squad`, purpose: 'platform failure notice tests' })
      .returning()
    squadId = squad.id
    const owner = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    const assignee = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    ownerAgentId = owner.id
    assigneeAgentId = assignee.id
    createdAgentIds.push(ownerAgentId, assigneeAgentId)
  })

  afterEach(async () => {
    await db.delete(inbox).where(eq(inbox.recipientId, ownerAgentId))
    if (createdStreamIds.length) {
      await db.delete(workStreamWaits).where(inArray(workStreamWaits.workStreamId, createdStreamIds))
      await db.delete(workStreams).where(inArray(workStreams.id, createdStreamIds))
      createdStreamIds.length = 0
    }
    await db.delete(executions).where(inArray(executions.agentId, createdAgentIds))
    await db.delete(agents).where(inArray(agents.id, createdAgentIds))
    createdAgentIds.length = 0
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  async function createStream(overrides: Partial<Parameters<typeof WorkStream.create>[0]> = {}) {
    const stream = await storedLegacyWorkStream({
      squadId,
      title: `${testPrefix} stream`,
      assigneeAgentId,
      agentIds: [assigneeAgentId],
      ownerAgentId,
      ...overrides,
    })
    createdStreamIds.push(stream.id)
    return stream
  }

  async function insertExecution(input: {
    status: 'failed' | 'completed'
    failureClass: string | null
    failureReason?: string | null
    agentId?: string
    error?: string
  }) {
    const [row] = await db
      .insert(executions)
      .values({
        agentId: input.agentId ?? assigneeAgentId,
        status: input.status,
        error: input.error ?? 'Admission effect was refused by the durable fence',
        failureClass: input.failureClass as never,
        failureReason: input.failureReason ?? null,
        endedAt: new Date('2026-01-02T03:04:05.000Z'),
      })
      .returning()
    return row
  }

  async function ownerNotices() {
    const rows = await db.select().from(inbox).where(eq(inbox.recipientId, ownerAgentId))
    // Only this module's notices — other lifecycle events (assigned/blocked)
    // legitimately reach the same owner.
    return rows.filter((row) => row.subject?.startsWith('Work stream execution failed:'))
  }

  test('sends exactly one notice per (execution, stream) across repeated events', async () => {
    const stream = await createStream()
    const execution = await insertExecution({
      status: 'failed',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
    })

    // Repeated events (retry/restart replays) must not duplicate.
    expect(await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: execution.id, agentId: assigneeAgentId })).toBe(
      1
    )
    expect(await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: execution.id, agentId: assigneeAgentId })).toBe(
      1
    )
    // A second distinct execution for the same stream is a NEW episode and notifies again.
    const second = await insertExecution({ status: 'failed', failureClass: 'platform_pre_tool_refusal' })
    expect(await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: second.id, agentId: assigneeAgentId })).toBe(1)

    const notices = await ownerNotices()
    expect(notices).toHaveLength(2)
    const keys = notices.map((n) => n.idempotencyKey)
    expect(keys).toContain(`ws-platform-failure:${execution.id}:${stream.id}`)
    expect(keys).toContain(`ws-platform-failure:${second.id}:${stream.id}`)
  })

  test('the notice carries only sanitized fields and never the raw error prose', async () => {
    const execution = await insertExecution({
      status: 'failed',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      error: 'Admission effect was refused by the durable fence SECRET-PAYLOAD-XYZ',
    })
    await createStream()

    await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: execution.id, agentId: assigneeAgentId })

    const [notice] = await ownerNotices()
    expect(notice).toBeTruthy()
    expect(notice.content).toContain(execution.id)
    expect(notice.content).toContain('platform_pre_tool_refusal')
    expect(notice.content).toContain('admission_fence-closed')
    // Raw error prose (which may carry provider payloads) never escapes.
    expect(notice.content).not.toContain('Admission effect was refused')
    expect(notice.content).not.toContain('SECRET-PAYLOAD-XYZ')
    expect(notice.metadata).toMatchObject({
      workStreamId: expect.any(String),
      executionId: execution.id,
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
    })
  })

  test('non-platform failures and legacy unclassified rows never notify', async () => {
    await createStream()
    for (const failureClass of ['provider_transport', 'provider_model', 'execution_failure', null]) {
      const execution = await insertExecution({
        status: 'failed',
        failureClass,
        failureReason: failureClass ? 'x'.repeat(8) : null,
      })
      expect(
        await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: execution.id, agentId: assigneeAgentId })
      ).toBe(0)
    }
    // A completed execution with a stray class-like field is ignored by status.
    const completed = await insertExecution({ status: 'completed', failureClass: null })
    expect(await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: completed.id, agentId: assigneeAgentId })).toBe(
      0
    )
    expect(await ownerNotices()).toHaveLength(0)
  })

  test('streams with open waits, inactive streams, and unowned streams are skipped', async () => {
    const waited = await createStream({ title: `${testPrefix} waited` })
    await waited.block({ message: 'held by operator' })
    const canceled = await createStream({ title: `${testPrefix} canceled` })
    await db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, canceled.id))
    await createStream({ title: `${testPrefix} unowned`, ownerAgentId: null })
    const healthy = await createStream({ title: `${testPrefix} healthy` })

    const execution = await insertExecution({ status: 'failed', failureClass: 'platform_pre_tool_refusal' })
    expect(await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: execution.id, agentId: assigneeAgentId })).toBe(
      1
    )

    const notices = await ownerNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0].metadata).toMatchObject({ workStreamId: healthy.id })
  })

  test('a stream that lists the agent in agentIds but not as assignee is still notified', async () => {
    const stream = await createStream({
      assigneeAgentId: ownerAgentId,
      agentIds: [ownerAgentId, assigneeAgentId],
      title: `${testPrefix} crew`,
    })
    const execution = await insertExecution({ status: 'failed', failureClass: 'platform_pre_tool_refusal' })
    expect(await notifyWorkStreamOwnersOfPlatformRefusal({ executionId: execution.id, agentId: assigneeAgentId })).toBe(
      1
    )
    const notices = await ownerNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0].metadata).toMatchObject({ workStreamId: stream.id })
  })

  test('an unknown execution id is a no-op, not an error', async () => {
    expect(
      await notifyWorkStreamOwnersOfPlatformRefusal({
        executionId: '00000000-0000-4000-8000-0000000000aa',
        agentId: assigneeAgentId,
      })
    ).toBe(0)
  })
})
