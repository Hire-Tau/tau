import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
  agentQuestionRecipients,
  agentQuestionWorkStreamOrigins,
  agentQuestions,
  agents,
  agentTypes,
  executions,
  inbox,
  messages,
  squads,
  workStreams,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Squad } from '../../entities/Squad'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'
import { listTrustedWorkStreamOriginsForExecution } from '../work-streams/execution-provenance'
import { listWorkStreamSubscriberIds, subscribeToWorkStream } from '../work-streams/subscriptions'
import { hasPermission } from '../rbac'
import { listPendingActionsForIdentity } from './actions'
import { finalizeAgentQuestionAttentionRouting, listAgentQuestionAttentionUserIds } from './questions'
import { reconcileAgentQuestionAttentionOnce } from './question-attention-reconciliation'

async function systemInboxNoticesFor(questionId: string): Promise<number> {
  const rows = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(and(sql`${inbox.metadata}->>'questionId' = ${questionId}`, eq(inbox.recipientType, 'system')))
  return rows.length
}

async function cleanupSystemInboxNoticesFor(questionId: string): Promise<void> {
  await db
    .delete(inbox)
    .where(and(sql`${inbox.metadata}->>'questionId' = ${questionId}`, eq(inbox.recipientType, 'system')))
}

describe('legacy agent question attention reconciliation', () => {
  let prefix: string
  let agentTypeId: string
  let squad: Squad
  let agent: Agent
  let user: TestUser

  beforeEach(async () => {
    prefix = `aq-repair-${crypto.randomUUID()}`
    agentTypeId = `${prefix}-type`
    await AgentType.create({ id: agentTypeId, name: 'Repair', model: 'test:model', systemPrompt: 'test' })
    squad = await Squad.create({ name: prefix, purpose: 'repair test' })
    agent = await Agent.create({ agentTypeId, squadId: squad.id })
    user = await createTestUser({ prefix })
  })

  afterEach(async () => {
    await db.delete(agentQuestions).where(eq(agentQuestions.agentId, agent.id))
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.delete(messages).where(eq(messages.agentId, agent.id))
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    await db.delete(agents).where(eq(agents.id, agent.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    await cleanupTestRbac(prefix)
  })

  test('bounds each repair sweep to its limit and becomes quiescent without duplicating writes', async () => {
    // Two repairable legacy questions with disjoint execution windows: minute-offset
    // timestamps keep each question's window unambiguous (exactly one execution).
    const repairable = await Promise.all(
      [10, 5].map(async (minutesAgo) => {
        const questionCreatedAt = new Date(Date.now() - minutesAgo * 60_000)
        const [execution] = await db
          .insert(executions)
          .values({
            agentId: agent.id,
            status: 'completed',
            startedAt: new Date(questionCreatedAt.getTime() - 60_000),
            endedAt: new Date(questionCreatedAt.getTime() + 60_000),
          })
          .returning()
        const [question] = await db
          .insert(agentQuestions)
          .values({
            agentId: agent.id,
            squadId: squad.id,
            questionData: { questions: [{ id: `q-${minutesAgo}`, type: 'text', question: 'Legacy?' }] },
            createdAt: questionCreatedAt,
          })
          .returning()
        await db.insert(messages).values({
          agentId: agent.id,
          role: 'human',
          content: `consumed participant ${minutesAgo}`,
          pending: false,
          metadata: {
            source: 'user_chat',
            sender: { userId: user.id, name: 'User' },
            executionId: execution.id,
            consumedAt: new Date(questionCreatedAt.getTime() - 1_000).toISOString(),
          },
        })
        return { question, execution }
      })
    )
    const ids = repairable.map(({ question }) => question.id)

    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: ids, limit: 1 })).toMatchObject({
      processed: 1,
      resolved: 1,
    })
    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: ids, limit: 1 })).toMatchObject({
      processed: 1,
      resolved: 1,
    })
    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: ids, limit: 1 })).toEqual({
      processed: 0,
      resolved: 0,
      unresolved: 0,
    })

    for (const { question } of repairable) {
      const rows = await db
        .select()
        .from(agentQuestionRecipients)
        .where(eq(agentQuestionRecipients.questionId, question.id))
      expect(rows).toHaveLength(1)
      const [repaired] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
      expect(repaired.audienceResolution).toBe('resolved')
    }
  })

  test('repairs a single exact execution once and never duplicates recipients', async () => {
    const questionCreatedAt = new Date()
    const [execution] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'completed',
        startedAt: new Date(questionCreatedAt.getTime() - 60_000),
        endedAt: new Date(questionCreatedAt.getTime() + 60_000),
      })
      .returning()
    const [question] = await db
      .insert(agentQuestions)
      .values({
        agentId: agent.id,
        squadId: squad.id,
        questionData: { questions: [{ id: 'q', type: 'text', question: 'Legacy?' }] },
        createdAt: questionCreatedAt,
      })
      .returning()
    const [unrelatedSentinel] = await db
      .insert(agentQuestions)
      .values({
        agentId: agent.id,
        squadId: squad.id,
        questionData: { questions: [{ id: 'sentinel', type: 'text', question: 'Do not reconcile' }] },
      })
      .returning()
    await db.insert(messages).values([
      {
        agentId: agent.id,
        role: 'human',
        content: 'consumed participant',
        pending: false,
        metadata: {
          source: 'user_chat',
          sender: { userId: user.id, name: 'User' },
          executionId: execution.id,
          consumedAt: new Date(questionCreatedAt.getTime() - 1_000).toISOString(),
        },
      },
      {
        agentId: agent.id,
        role: 'human',
        content: 'malformed authenticated sender',
        pending: false,
        metadata: {
          source: 'user_chat',
          sender: { userId: 'not-a-uuid', name: 'Malformed' },
          executionId: execution.id,
          consumedAt: new Date(questionCreatedAt.getTime() - 1_000).toISOString(),
        },
      },
    ])

    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: [question.id] })).toMatchObject({
      resolved: 1,
      unresolved: 0,
    })
    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: [question.id] })).toEqual({
      processed: 0,
      resolved: 0,
      unresolved: 0,
    })
    expect(
      await db.select().from(agentQuestionRecipients).where(eq(agentQuestionRecipients.questionId, question.id))
    ).toHaveLength(1)
    const [repaired] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(repaired.audienceResolution).toBe('resolved')
    expect(repaired.executionId).toBe(execution.id)
    const [untouchedSentinel] = await db
      .select({ resolution: agentQuestions.audienceResolution })
      .from(agentQuestions)
      .where(eq(agentQuestions.id, unrelatedSentinel.id))
    expect(untouchedSentinel).toEqual({ resolution: null })
  })

  test('resolves an exact origin for an authorized work-stream-only subscriber', async () => {
    const role = await createTestRole({ prefix: `${prefix}-origin`, permissions: ['actions:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })
    const stream = await storedLegacyWorkStream({
      squadId: squad.id,
      title: 'Exact origin',
      assigneeAgentId: agent.id,
      agentIds: [agent.id],
    })
    await subscribeToWorkStream(stream.id, user.id)
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    const createdAt = new Date()
    const [execution] = await db
      .insert(executions)
      .values({
        agentId: agent.id,
        status: 'completed',
        startedAt: new Date(createdAt.getTime() - 60_000),
        endedAt: new Date(createdAt.getTime() + 60_000),
      })
      .returning()
    const [question] = await db
      .insert(agentQuestions)
      .values({
        agentId: agent.id,
        squadId: squad.id,
        questionData: { questions: [{ id: 'q', type: 'text', question: 'Origin subscriber?' }] },
        createdAt,
      })
      .returning()
    await db.insert(messages).values({
      agentId: agent.id,
      role: 'human',
      content: 'trusted origin',
      pending: false,
      metadata: {
        source: 'work-stream-continuation',
        workStreamId: stream.id,
        executionId: execution.id,
        consumedAt: new Date(createdAt.getTime() - 1_000).toISOString(),
      },
    })
    expect(await listWorkStreamSubscriberIds(stream.id)).toContain(user.id)
    expect(await hasPermission({ type: 'user', userId: user.id }, 'actions:read', squad.id)).toBe(true)
    expect(
      await listTrustedWorkStreamOriginsForExecution(db, { agentId: agent.id, executionId: execution.id })
    ).toEqual([{ workStreamId: stream.id, messageIds: [expect.any(String)] }])

    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: [question.id] })).toMatchObject({
      resolved: 1,
      unresolved: 0,
    })
    expect(await listAgentQuestionAttentionUserIds(question.id)).toContain(user.id)
    expect(
      (await listPendingActionsForIdentity({ type: 'user', userId: user.id })).map((action) => action.id)
    ).toContain(`agent-question:${question.id}`)
    expect(
      await db
        .select({ workStreamId: agentQuestionWorkStreamOrigins.workStreamId })
        .from(agentQuestionWorkStreamOrigins)
        .where(eq(agentQuestionWorkStreamOrigins.questionId, question.id))
    ).toEqual([{ workStreamId: stream.id }])
  })

  test('marks an unresolvable legacy question unresolved once without any system-inbox notice', async () => {
    const [question] = await db
      .insert(agentQuestions)
      .values({
        agentId: agent.id,
        squadId: squad.id,
        questionData: { questions: [{ id: 'q', type: 'text', question: 'Unresolvable?' }] },
      })
      .returning()

    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: [question.id] })).toMatchObject({
      unresolved: 1,
    })
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.audienceResolution).toBe('legacy-unresolved')
    expect(row.audienceAlertedAt).toBeNull()
    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: [question.id] })).toMatchObject({
      processed: 0,
    })
    expect(await systemInboxNoticesFor(question.id)).toBe(0)
    await cleanupSystemInboxNoticesFor(question.id)
  })

  test('creator and repair finalization converge without any system-inbox notice', async () => {
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const [question] = await db
      .insert(agentQuestions)
      .values({
        agentId: agent.id,
        squadId: squad.id,
        executionId: execution.id,
        audienceResolution: 'pending',
        questionData: { questions: [{ id: 'q', type: 'text', question: 'Race?' }] },
      })
      .returning()

    await Promise.all([
      finalizeAgentQuestionAttentionRouting(question.id),
      reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: [question.id] }),
    ])

    const [finalized] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(finalized.audienceResolution === 'unroutable' || finalized.audienceResolution === 'legacy-unresolved').toBe(
      true
    )
    expect(finalized.audienceAlertedAt).toBeNull()
    expect(await systemInboxNoticesFor(question.id)).toBe(0)
    await cleanupSystemInboxNoticesFor(question.id)
  })

  test('marks an ambiguous legacy question unresolved exactly once', async () => {
    const createdAt = new Date()
    for (let index = 0; index < 2; index += 1) {
      await db.insert(executions).values({
        agentId: agent.id,
        status: 'running',
        startedAt: new Date(createdAt.getTime() - 60_000),
      })
    }
    const [question] = await db
      .insert(agentQuestions)
      .values({
        agentId: agent.id,
        squadId: squad.id,
        questionData: { questions: [{ id: 'q', type: 'text', question: 'Ambiguous?' }] },
        createdAt,
      })
      .returning()

    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: [question.id] })).toMatchObject({
      unresolved: 1,
    })
    expect(await reconcileAgentQuestionAttentionOnce({ candidateQuestionIds: [question.id] })).toMatchObject({
      processed: 0,
    })
    const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, question.id))
    expect(row.audienceResolution).toBe('legacy-unresolved')
    expect(await systemInboxNoticesFor(question.id)).toBe(0)
    await cleanupSystemInboxNoticesFor(question.id)
  })
})
