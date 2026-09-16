import { isCurrentWaitAttempt, lockAgentFlowStream } from '../work-streams/wait-scope'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import {
  isAddressableAgentStatus,
  isLiveAgentStatus,
  type AgentQuestion,
  type AgentQuestionStatus,
  type QuestionData,
} from '@tau/shared'
import { db, agentQuestions } from '../../db'
import {
  agentQuestionRecipients,
  agentQuestionWorkStreamOrigins,
  agents,
  chatSendReceipts,
  executions,
  inbox,
  messages,
  users,
  workStreams,
  workStreamWaits,
} from '../../db/schema'
import { createLogger } from '../../lib/infra/logger'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { listSquadSubscriberIds } from '../squad/subscriptions'
import { closeOpenWaits, openWait } from '../work-streams/waits'
import { resetContinuationCycle } from '../work-streams/continuation-state'
import { isUuid, listTrustedWorkStreamOriginsForExecution } from '../work-streams/execution-provenance'
import { listWorkStreamSubscriberIds } from '../work-streams/subscriptions'
import { loadUserAttention } from '../attention/resolver'
import { canReceiveAgentQuestionAttention } from './pending-action-policy'
import { drainQuestionAnswerDeliverySoon } from './question-answer-delivery'
import { ensureQuestionDeliveryFailureAlert } from './question-delivery-failure-alert'

const log = createLogger('agent-questions')

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type ExpectedAgentScope = { ownerUserId: string | null; squadId: string | null }

type ChangedWorkStream = {
  id: string
  squadId: string
  status: 'active' | 'queued' | 'done' | 'canceled'
  assigneeAgentId: string | null
  agentIds: string[]
}

async function lockWorkStreams(tx: DbTransaction, workStreamIds: Iterable<string>): Promise<ChangedWorkStream[]> {
  const ids = [...new Set(workStreamIds)].sort()
  if (ids.length === 0) return []
  const rows = await tx
    .select({
      id: workStreams.id,
      squadId: workStreams.squadId,
      status: workStreams.status,
      assigneeAgentId: workStreams.assigneeAgentId,
      agentIds: workStreams.agentIds,
    })
    .from(workStreams)
    .where(inArray(workStreams.id, ids))
    .orderBy(asc(workStreams.id))
    .for('update')
  return rows.map((row) => ({ ...row, agentIds: row.agentIds ?? [] }))
}

async function lockExpectedAgent(
  tx: DbTransaction,
  agentId: string,
  expected: ExpectedAgentScope | undefined,
  lifecycle: 'live' | 'addressable' | 'any' = 'live'
): Promise<boolean> {
  await lockAgentFlowStream(tx, agentId)
  const [target] = await tx
    .select({
      ownerUserId: agents.ownerUserId,
      squadId: agents.squadId,
      status: agents.status,
      pendingDormancyAt: agents.pendingDormancyAt,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .for('update')
  if (!target) return false
  const lifecycleAllowed =
    lifecycle === 'any' ||
    (!target.pendingDormancyAt &&
      (lifecycle === 'addressable' ? isAddressableAgentStatus(target.status) : isLiveAgentStatus(target.status)))
  return Boolean(
    lifecycleAllowed &&
    (!expected || (target.ownerUserId === expected.ownerUserId && target.squadId === expected.squadId))
  )
}

async function resetChangedContinuations(tx: DbTransaction, rows: ChangedWorkStream[]): Promise<void> {
  const now = new Date()
  for (const row of rows) {
    if (row.assigneeAgentId && (row.status === 'active' || row.status === 'queued')) {
      await resetContinuationCycle(tx, row.id, row.assigneeAgentId, now)
    }
  }
}

function emitChangedWorkStreams(rows: Iterable<ChangedWorkStream>): void {
  const byId = new Map([...rows].map((row) => [row.id, row]))
  for (const row of byId.values()) {
    eventEmitter.emit('workStream.updated', { workStreamId: row.id, squadId: row.squadId })
  }
}

async function promoteChangedWorkStreams(rows: Iterable<ChangedWorkStream>, context: string): Promise<void> {
  const changed = [...rows]
  const squadIds = new Set(changed.map((row) => row.squadId))
  if (squadIds.size === 0) return
  try {
    const { ensureFlowDispatch } = await import('../workflows/execution')
    for (const row of changed) await ensureFlowDispatch(row.id)
    const { promoteEligibleQueuedStreams } = await import('../work-streams/admission')
    for (const squadId of squadIds) await promoteEligibleQueuedStreams(squadId)
  } catch (error) {
    log.warn(`${context} promotion failed (reconciler will converge):`, error)
  }
}

/** The trusted, persisted origin streams a blocking question may wait on. */
async function listWaitableOriginStreamIds(tx: DbTransaction, questionId: string, agentId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: workStreams.id })
    .from(agentQuestionWorkStreamOrigins)
    .innerJoin(workStreams, eq(agentQuestionWorkStreamOrigins.workStreamId, workStreams.id))
    .where(
      and(
        eq(agentQuestionWorkStreamOrigins.questionId, questionId),
        sql`(${workStreams.assigneeAgentId} = ${agentId} OR ${agentId} = ANY(${workStreams.agentIds}))`,
        inArray(workStreams.status, ['active', 'queued'])
      )
    )
  return rows.map((row) => row.id)
}

type Row = typeof agentQuestions.$inferSelect

function toJson(row: Row): AgentQuestion {
  const safe = {
    questionData: row.questionData,
    answer: row.answer,
    dismissalReason: row.dismissalReason,
    answerDeliveryLastError: row.answerDeliveryLastError,
  }
  return {
    id: row.id,
    agentId: row.agentId,
    squadId: row.squadId,
    ownerUserId: row.ownerUserId,
    executionId: row.executionId,
    audienceResolution: row.audienceResolution,
    questionData: safe.questionData as QuestionData,
    status: row.status as AgentQuestion['status'],
    answer: safe.answer,
    answeredByUserId: row.answeredByUserId,
    createdAt: row.createdAt.toISOString(),
    answeredAt: row.answeredAt ? row.answeredAt.toISOString() : null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    dismissalReason: safe.dismissalReason,
    dismissedByUserId: row.dismissedByUserId ?? null,
    dismissedByAgentId: row.dismissedByAgentId ?? null,
    ...(row.answerDeliveryStatus
      ? {
          answerDelivery: {
            status: row.answerDeliveryStatus,
            generation: row.answerDeliveryGeneration,
            attemptCount: row.answerDeliveryAttemptCount,
            nextAttemptAt: row.answerDeliveryNextAttemptAt?.toISOString() ?? null,
            lastError: safe.answerDeliveryLastError,
            deliveredAt: row.answerDeliveredAt?.toISOString() ?? null,
            canRetry: row.answerDeliveryStatus === 'failed',
          },
        }
      : {}),
  }
}

/**
 * Record an async question from an agent. The agent does NOT halt — it keeps working. squadId and
 * ownerUserId are denormalized from the agent for per-user Action Center scoping.
 *
 * `blocking: true` additionally opens a `question` wait (referencing the
 * question) only on trusted, non-terminal origin work streams in the SAME
 * transaction as the question insert. The default is non-blocking.
 */
export type AgentQuestionCreationResult = AgentQuestion & {
  openedWaitWorkStreamIds: string[]
}

export interface AgentQuestionOrigin {
  agentId: string
  executionId: string
}

function consumedAt(metadata: Record<string, unknown> | null): Date | null {
  if (typeof metadata?.consumedAt !== 'string') return null
  const parsed = new Date(metadata.consumedAt)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Finalize a pending attention resolution: `resolved` when the question has at
 * least one attention recipient (Action Center/push routing), `unroutable`
 * otherwise. An unroutable audience is a terminal routing state, not a failure:
 * the question stays visible to every agent reader and answerable, and no
 * system-inbox notice is sent for it.
 */
export async function finalizeAgentQuestionAttentionRouting(questionId: string): Promise<Row | null> {
  const current = await getAgentQuestionRow(questionId)
  if (!current) return null
  if (current.audienceResolution === 'pending') {
    const attentionRecipientIds = await listAgentQuestionAttentionUserIds(questionId)
    const resolution = attentionRecipientIds.length > 0 ? 'resolved' : 'unroutable'
    await db
      .update(agentQuestions)
      .set({ audienceResolution: resolution, audienceResolvedAt: new Date() })
      .where(and(eq(agentQuestions.id, questionId), eq(agentQuestions.audienceResolution, 'pending')))
  }
  return (await getAgentQuestionRow(questionId)) ?? current
}

async function getAgentQuestionRow(questionId: string): Promise<Row | null> {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
  return row ?? null
}

export async function createAgentQuestion(
  origin: AgentQuestionOrigin,
  questionData: QuestionData,
  opts: {
    blocking?: boolean
    waitScope?: 'stream' | 'attempt'
    testHooks?: {
      afterAgentLocked?: () => Promise<void>
      beforeAttentionFinalize?: () => Promise<void>
      afterWaitOpened?: (workStreamId: string, openedCount: number) => Promise<void>
    }
  } = {}
): Promise<AgentQuestionCreationResult> {
  const result = await db.transaction(async (tx) => {
    const [execution] = await tx
      .select({ agentId: executions.agentId, flowContext: executions.flowContext })
      .from(executions)
      .where(eq(executions.id, origin.executionId))
    if (!execution || execution.agentId !== origin.agentId) {
      throw new Error('Question execution does not belong to the asking agent')
    }
    await lockAgentFlowStream(tx, origin.agentId)
    const [agent] = await tx
      .select({
        squadId: agents.squadId,
        ownerUserId: agents.ownerUserId,
        status: agents.status,
        pendingDormancyAt: agents.pendingDormancyAt,
      })
      .from(agents)
      .where(eq(agents.id, origin.agentId))
      .for('update')
    if (!agent) throw new Error('Asking agent not found')
    if (!isLiveAgentStatus(agent.status) || agent.pendingDormancyAt)
      throw new Error('Asking agent is terminating or not live')
    await opts.testHooks?.afterAgentLocked?.()

    const [created] = await tx
      .insert(agentQuestions)
      .values({
        agentId: origin.agentId,
        squadId: agent.squadId ?? null,
        ownerUserId: agent.ownerUserId ?? null,
        executionId: origin.executionId,
        audienceResolution: 'pending',
        questionData,
      })
      .returning()

    const candidateOrigins = await listTrustedWorkStreamOriginsForExecution(tx, origin)
    const originMessageIds = candidateOrigins.flatMap(({ messageIds }) => messageIds)
    const consumedOriginMessageIds = new Set<string>()
    if (originMessageIds.length > 0) {
      const rows = await tx
        .select({ id: messages.id, pending: messages.pending, metadata: messages.metadata })
        .from(messages)
        .where(inArray(messages.id, originMessageIds))
      for (const row of rows) {
        const metadata = row.metadata as Record<string, unknown> | null
        const consumed = consumedAt(metadata)
        if (!row.pending && consumed && consumed <= created.createdAt) consumedOriginMessageIds.add(row.id)
      }
    }
    const trustedOrigins = candidateOrigins.filter(({ messageIds }) =>
      messageIds.some((messageId) => consumedOriginMessageIds.has(messageId))
    )
    const trustedOriginIds = trustedOrigins.map(({ workStreamId }) => workStreamId)

    if (trustedOriginIds.length > 0) {
      await tx
        .insert(agentQuestionWorkStreamOrigins)
        .values(trustedOriginIds.map((workStreamId) => ({ questionId: created.id, workStreamId })))
        .onConflictDoNothing()
    }

    const participantIds = new Set<string>()
    const participantRows = await tx
      .select({ pending: messages.pending, metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          eq(messages.agentId, origin.agentId),
          eq(messages.role, 'human'),
          sql`${messages.metadata}->>'executionId' = ${origin.executionId}`
        )
      )
    for (const row of participantRows) {
      const metadata = row.metadata as Record<string, unknown> | null
      const sender = metadata?.sender as { userId?: unknown } | undefined
      const consumed = consumedAt(metadata)
      if (
        !row.pending &&
        metadata?.source === 'user_chat' &&
        isUuid(sender?.userId) &&
        consumed &&
        consumed <= created.createdAt
      ) {
        participantIds.add(sender.userId)
      }
    }

    const originStreams = trustedOriginIds.length
      ? await tx
          .select({ id: workStreams.id, requestingUserId: workStreams.requestingUserId })
          .from(workStreams)
          .where(inArray(workStreams.id, trustedOriginIds))
      : []
    const requesterIds = new Set(
      originStreams.flatMap(({ requestingUserId }) => (requestingUserId ? [requestingUserId] : []))
    )
    const candidateRecipientIds = [...new Set([...participantIds, ...requesterIds])]
    const enabledIds = new Set<string>()
    if (candidateRecipientIds.length > 0) {
      const enabled = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, candidateRecipientIds), isNull(users.disabledAt)))
      for (const { id } of enabled) enabledIds.add(id)
    }
    if (enabledIds.size > 0) {
      await tx
        .insert(agentQuestionRecipients)
        .values(
          [...enabledIds].map((userId) => ({
            questionId: created.id,
            userId,
            reason: participantIds.has(userId) ? ('execution-participant' as const) : ('workstream-requester' as const),
          }))
        )
        .onConflictDoNothing()
    }

    const openedWaitWorkStreamIds: string[] = []
    let changedWorkStreams: ChangedWorkStream[] = []
    if (opts.blocking && trustedOriginIds.length > 0) {
      const waitableIds = await tx
        .select({ id: workStreams.id })
        .from(workStreams)
        .where(
          and(
            inArray(workStreams.id, trustedOriginIds),
            sql`(${workStreams.assigneeAgentId} = ${origin.agentId} OR ${origin.agentId} = ANY(${workStreams.agentIds}))`,
            inArray(workStreams.status, ['active', 'queued'])
          )
        )
      const waitable = (
        await lockWorkStreams(
          tx,
          waitableIds.map(({ id }) => id)
        )
      ).filter(
        (stream) =>
          (stream.status === 'active' || stream.status === 'queued') &&
          (stream.assigneeAgentId === origin.agentId || stream.agentIds.includes(origin.agentId))
      )
      const message = questionData.questions
        ?.map((question) => question.question)
        .filter(Boolean)
        .join('\n')
      for (const { id: workStreamId } of waitable) {
        if (
          execution.flowContext?.workStreamId === workStreamId &&
          !(await isCurrentWaitAttempt(tx, workStreamId, execution.flowContext.attemptId, origin.agentId))
        )
          throw new Error('The question belongs to a superseded flow attempt')
        const { wait } = await openWait(tx, {
          workStreamId,
          type: 'question',
          referenceId: created.id,
          scope: opts.waitScope,
          flowAttemptId:
            opts.waitScope !== 'stream' && execution.flowContext?.workStreamId === workStreamId
              ? execution.flowContext.attemptId
              : undefined,
          message: message || null,
          createdBy: 'agent',
          createdByAgentId: origin.agentId,
        })
        openedWaitWorkStreamIds.push(wait.workStreamId)
        await opts.testHooks?.afterWaitOpened?.(wait.workStreamId, openedWaitWorkStreamIds.length)
      }
      changedWorkStreams = waitable.filter((row) => openedWaitWorkStreamIds.includes(row.id))
      await resetChangedContinuations(tx, changedWorkStreams)
    }
    return { row: created, openedWaitWorkStreamIds, changedWorkStreams }
  })

  // The wait transaction is committed: publish its invalidation before any later attention
  // finalization, which may fail independently and must not hide the committed wait.
  emitChangedWorkStreams(result.changedWorkStreams)
  const { ensureFlowDispatch } = await import('../workflows/execution')
  for (const stream of result.changedWorkStreams) await ensureFlowDispatch(stream.id)

  let row = result.row
  await opts.testHooks?.beforeAttentionFinalize?.()
  row = (await finalizeAgentQuestionAttentionRouting(row.id)) ?? row

  eventEmitter.emit('agent-question.created', {
    questionId: row.id,
    agentId: row.agentId,
    squadId: row.squadId,
  })
  return {
    ...toJson(row),
    openedWaitWorkStreamIds: result.openedWaitWorkStreamIds,
  }
}

/**
 * Convert an existing OPEN question to blocking (opens `question` waits on
 * the asking agent's streams) or back to non-blocking (closes them,
 * `cleared`). Idempotent per stream. Returns null when the question is
 * missing or answered.
 */
export async function setQuestionBlocking(
  id: string,
  blocking: boolean,
  opts: { expectedAgentScope?: ExpectedAgentScope } = {}
): Promise<AgentQuestion | null> {
  const result = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ agentId: agentQuestions.agentId })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, 'open')))
    if (!candidate || !(await lockExpectedAgent(tx, candidate.agentId, opts.expectedAgentScope, 'addressable')))
      return null
    const [row] = await tx
      .select()
      .from(agentQuestions)
      .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, 'open')))
      .for('update')
    if (!row) return null

    let changedWorkStreams: ChangedWorkStream[] = []
    if (blocking) {
      const message = (row.questionData as QuestionData | null)?.questions
        ?.map((q) => q.question)
        .filter(Boolean)
        .join('\n')
      const [questionExecution] = row.executionId
        ? await tx
            .select({ flowContext: executions.flowContext })
            .from(executions)
            .where(eq(executions.id, row.executionId))
        : []
      const streamIds = await listWaitableOriginStreamIds(tx, row.id, row.agentId)
      const locked = await lockWorkStreams(tx, streamIds)
      const waitable = locked.filter(
        (stream) =>
          (stream.status === 'active' || stream.status === 'queued') &&
          (stream.assigneeAgentId === row.agentId || stream.agentIds.includes(row.agentId))
      )
      const existing = waitable.length
        ? await tx
            .select({ workStreamId: workStreamWaits.workStreamId })
            .from(workStreamWaits)
            .where(
              and(
                eq(workStreamWaits.referenceId, id),
                eq(workStreamWaits.type, 'question'),
                isNull(workStreamWaits.closedAt)
              )
            )
        : []
      const already = new Set(existing.map((wait) => wait.workStreamId))
      const openedIds: string[] = []
      for (const { id: workStreamId } of waitable) {
        if (already.has(workStreamId)) continue
        if (
          questionExecution?.flowContext?.workStreamId === workStreamId &&
          !(await isCurrentWaitAttempt(tx, workStreamId, questionExecution.flowContext.attemptId, row.agentId))
        )
          throw new Error('The question belongs to a superseded flow attempt')
        const [previousWait] = await tx
          .select()
          .from(workStreamWaits)
          .where(
            and(
              eq(workStreamWaits.workStreamId, workStreamId),
              eq(workStreamWaits.referenceId, id),
              eq(workStreamWaits.type, 'question')
            )
          )
          .orderBy(desc(workStreamWaits.openedAt))
          .limit(1)
        const { wait } = await openWait(tx, {
          workStreamId,
          type: 'question',
          referenceId: id,
          scope: previousWait && previousWait.flowAttemptId == null ? 'stream' : undefined,
          flowAttemptId: previousWait
            ? (previousWait.flowAttemptId ?? undefined)
            : questionExecution?.flowContext?.workStreamId === workStreamId
              ? questionExecution.flowContext.attemptId
              : undefined,
          message: message || null,
          createdBy: 'manager',
          createdByAgentId: row.agentId,
        })
        openedIds.push(wait.workStreamId)
      }
      changedWorkStreams = waitable.filter((stream) => openedIds.includes(stream.id))
    } else {
      const openWaits = await tx
        .select({ workStreamId: workStreamWaits.workStreamId })
        .from(workStreamWaits)
        .where(
          and(
            eq(workStreamWaits.referenceId, id),
            eq(workStreamWaits.type, 'question'),
            isNull(workStreamWaits.closedAt)
          )
        )
      const locked = await lockWorkStreams(
        tx,
        openWaits.map(({ workStreamId }) => workStreamId)
      )
      const closed = await closeOpenWaits(tx, { type: 'question', referenceId: id }, 'cleared')
      const closedIds = new Set(closed.map((wait) => wait.workStreamId))
      changedWorkStreams = locked.filter((stream) => closedIds.has(stream.id))
    }
    await resetChangedContinuations(tx, changedWorkStreams)
    return { row, changedWorkStreams }
  })
  if (!result) return null
  emitChangedWorkStreams(result.changedWorkStreams)
  await promoteChangedWorkStreams(result.changedWorkStreams, 'Post-question-scope-change')
  return toJson(result.row)
}

type AgentQuestionListFilter =
  | { status?: AgentQuestionStatus; statuses?: never }
  | { status?: never; statuses: readonly [AgentQuestionStatus, ...AgentQuestionStatus[]] }

export async function listAgentQuestions(
  agentId: string,
  opts: AgentQuestionListFilter = {}
): Promise<AgentQuestion[]> {
  const conditions = [eq(agentQuestions.agentId, agentId)]
  if (opts.status) conditions.push(eq(agentQuestions.status, opts.status))
  else if (opts.statuses) conditions.push(inArray(agentQuestions.status, [...opts.statuses]))
  const rows = await db
    .select()
    .from(agentQuestions)
    .where(and(...conditions))
    .orderBy(desc(agentQuestions.createdAt))
  return rows.map(toJson)
}

export async function getAgentQuestion(id: string): Promise<AgentQuestion | null> {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id))
  return row ? toJson(row) : null
}

/**
 * Users eligible to see a question-created notification. The persisted question is authoritative:
 * its owner always qualifies, while squad subscribers must also be allowed to read pending actions.
 */
export async function listAgentQuestionAttentionUserIds(questionId: string): Promise<string[]> {
  const question = await getAgentQuestion(questionId)
  if (!question) return []

  const squadId = question.squadId
  const subscribers = squadId ? await listSquadSubscriberIds(squadId) : []
  const persistedOrigins = await db
    .select({ workStreamId: agentQuestionWorkStreamOrigins.workStreamId })
    .from(agentQuestionWorkStreamOrigins)
    .where(eq(agentQuestionWorkStreamOrigins.questionId, questionId))
  const originSubscribers = (
    await Promise.all(persistedOrigins.map(({ workStreamId }) => listWorkStreamSubscriberIds(workStreamId)))
  ).flat()
  const dynamicSubscribers = [...new Set([...subscribers, ...originSubscribers])]
  const explicitRecipients = await db
    .select({ userId: agentQuestionRecipients.userId })
    .from(agentQuestionRecipients)
    .where(eq(agentQuestionRecipients.questionId, questionId))
  const explicitIds = explicitRecipients.map(({ userId }) => userId)
  // A stored owner is an attention candidate only for a squadless personal agent; a
  // squad-bound agent's owner snapshot is metadata, not an attention entitlement.
  const personalOwnerIds = question.ownerUserId && !question.squadId ? [question.ownerUserId] : []
  const candidateIds = [...new Set([...personalOwnerIds, ...explicitIds, ...dynamicSubscribers])]
  if (candidateIds.length === 0) return []

  // Disabled accounts cannot access Action Center and must never receive retained-device push content.
  const enabledRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, candidateIds), isNull(users.disabledAt)))
  const enabled = new Set(enabledRows.map(({ id }) => id))

  // This question's origins are already loaded above; hand them to the policy so it resolves
  // origin precedence in memory instead of re-querying them for every candidate.
  const questionOrigins = new Map([[question.id, persistedOrigins.map(({ workStreamId }) => workStreamId)]])
  const authorized = await Promise.all(
    [...enabled].map(async (userId) => {
      const visible = await canReceiveAgentQuestionAttention(
        { type: 'user', userId },
        { id: question.id, ownerUserId: question.ownerUserId, squadId: question.squadId },
        { attention: await loadUserAttention(userId), questionOrigins }
      )
      return visible ? userId : null
    })
  )
  return authorized.filter((userId): userId is string => Boolean(userId))
}

export async function listActionableAgentQuestions(): Promise<AgentQuestion[]> {
  const rows = await db
    .select({ question: agentQuestions })
    .from(agentQuestions)
    .innerJoin(agents, eq(agents.id, agentQuestions.agentId))
    .where(
      and(
        ne(agents.status, 'terminated'),
        isNull(agents.pendingDormancyAt),
        or(
          eq(agentQuestions.status, 'open'),
          and(eq(agentQuestions.status, 'answered'), eq(agentQuestions.answerDeliveryStatus, 'failed'))
        )
      )
    )
    .orderBy(desc(agentQuestions.createdAt))
  return rows.map(({ question }) => toJson(question))
}

export async function reconcileQuestionsForTerminatedAgentInTransaction(
  tx: DbTransaction,
  agentId: string,
  now = new Date()
) {
  const rows = await tx
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.agentId, agentId),
        or(
          eq(agentQuestions.status, 'open'),
          and(
            eq(agentQuestions.status, 'answered'),
            inArray(agentQuestions.answerDeliveryStatus, ['pending', 'delivering'])
          )
        )
      )
    )
    .orderBy(asc(agentQuestions.id))
    .for('update')
  if (rows.length === 0) return { dismissed: [], delivered: [], failed: [], changedWorkStreams: [] }

  const dismissed = rows.filter((row) => row.status === 'open')
  const delivered: typeof rows = []
  const failed: typeof rows = []
  for (const row of rows.filter(
    (candidate) =>
      candidate.status === 'answered' && ['pending', 'delivering'].includes(candidate.answerDeliveryStatus ?? '')
  )) {
    const clientId = `agent-question-answer:v1:${row.id}:inbox`
    const inboxKey = `agent-question-answer:v1:${row.id}`
    const [receipt] = await tx
      .select({
        state: chatSendReceipts.state,
        messageId: chatSendReceipts.messageId,
        executionId: chatSendReceipts.executionId,
      })
      .from(chatSendReceipts)
      .where(and(eq(chatSendReceipts.agentId, agentId), eq(chatSendReceipts.clientId, clientId)))
    const [answerInbox] = await tx.select({ id: inbox.id }).from(inbox).where(eq(inbox.idempotencyKey, inboxKey))
    if (receipt?.state === 'accepted' && receipt.messageId && receipt.executionId && answerInbox) {
      await tx
        .update(agentQuestions)
        .set({
          answerDeliveryStatus: 'delivered',
          answerDeliveryClaimToken: null,
          answerDeliveryClaimedAt: null,
          answerDeliveryNextAttemptAt: null,
          answerDeliveryLastError: null,
          answerDeliveryInboxMessageId: answerInbox.id,
          answerDeliveryMessageId: receipt.messageId,
          answerDeliveryExecutionId: receipt.executionId,
          answerDeliveredAt: now,
        })
        .where(eq(agentQuestions.id, row.id))
      await tx.update(inbox).set({ deliveredAt: now }).where(eq(inbox.id, answerInbox.id))
      delivered.push(row)
    } else {
      failed.push(row)
    }
  }
  const dismissedIds = dismissed.map((row) => row.id)
  const failedIds = failed.map((row) => row.id)
  const waits = dismissedIds.length
    ? await tx
        .select({ workStreamId: workStreamWaits.workStreamId })
        .from(workStreamWaits)
        .where(
          and(
            eq(workStreamWaits.type, 'question'),
            inArray(workStreamWaits.referenceId, dismissedIds),
            isNull(workStreamWaits.closedAt)
          )
        )
    : []
  const locked = await lockWorkStreams(
    tx,
    waits.map((wait) => wait.workStreamId)
  )

  if (dismissedIds.length) {
    await tx
      .update(agentQuestions)
      .set({ status: 'dismissed', dismissedAt: now, dismissalReason: 'asking-agent-terminated' })
      .where(and(inArray(agentQuestions.id, dismissedIds), eq(agentQuestions.status, 'open')))
    for (const questionId of dismissedIds) {
      await closeOpenWaits(tx, { type: 'question', referenceId: questionId }, 'cleared', {
        closedAt: now,
        note: 'Asking agent terminated',
      })
    }
  }
  if (failedIds.length) {
    await tx
      .update(agentQuestions)
      .set({
        answerDeliveryStatus: 'failed',
        answerDeliveryGeneration: sql`${agentQuestions.answerDeliveryGeneration} + 1`,
        answerDeliveryNextAttemptAt: null,
        answerDeliveryClaimToken: null,
        answerDeliveryClaimedAt: null,
        answerDeliveryLastError: 'Asking agent terminated before answer delivery',
      })
      .where(
        and(
          inArray(agentQuestions.id, failedIds),
          inArray(agentQuestions.answerDeliveryStatus, ['pending', 'delivering'])
        )
      )
  }
  const changedIds = new Set(waits.map((wait) => wait.workStreamId))
  const changedWorkStreams = locked.filter((stream) => changedIds.has(stream.id))
  await resetChangedContinuations(tx, changedWorkStreams)
  return { dismissed, delivered, failed, changedWorkStreams }
}

type TerminatedQuestionResult = Awaited<ReturnType<typeof reconcileQuestionsForTerminatedAgentInTransaction>>

export async function publishTerminatedAgentQuestionResult(result: TerminatedQuestionResult): Promise<void> {
  for (const row of result.dismissed) {
    eventEmitter.emit('agent-question.dismissed', { questionId: row.id, agentId: row.agentId, squadId: row.squadId })
  }
  for (const row of result.failed) {
    eventEmitter.emit('agent-question.delivery-failed', {
      questionId: row.id,
      agentId: row.agentId,
      squadId: row.squadId,
    })
    try {
      await ensureQuestionDeliveryFailureAlert(row.id)
    } catch (error) {
      log.warn(`Failure alert for terminated-agent question ${row.id.slice(0, 8)} will be retried:`, error)
    }
  }
  emitChangedWorkStreams(result.changedWorkStreams)
  await promoteChangedWorkStreams(result.changedWorkStreams, 'Post-termination')
}

export async function reconcileQuestionsForTerminatedAgent(agentId: string): Promise<void> {
  const result = await db.transaction((tx) => reconcileQuestionsForTerminatedAgentInTransaction(tx, agentId))
  await publishTerminatedAgentQuestionResult(result)
}

export async function reconcileTerminatedAgentQuestionsOnce(limit = 100): Promise<number> {
  const rows = await db
    .selectDistinct({ agentId: agentQuestions.agentId })
    .from(agentQuestions)
    .innerJoin(agents, eq(agents.id, agentQuestions.agentId))
    .where(
      and(
        eq(agents.status, 'terminated'),
        or(
          eq(agentQuestions.status, 'open'),
          and(
            eq(agentQuestions.status, 'answered'),
            inArray(agentQuestions.answerDeliveryStatus, ['pending', 'delivering'])
          )
        )
      )
    )
    .limit(limit)
  for (const { agentId } of rows) await reconcileQuestionsForTerminatedAgent(agentId)
  return rows.length
}

export async function retryAgentQuestionAnswerDelivery(
  id: string,
  opts: { expectedAgentScope?: ExpectedAgentScope; testHooks?: { beforeAgentScopeLock?: () => Promise<void> } } = {}
): Promise<AgentQuestion | null> {
  const updated = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ agentId: agentQuestions.agentId })
      .from(agentQuestions)
      .where(
        and(
          eq(agentQuestions.id, id),
          eq(agentQuestions.status, 'answered'),
          eq(agentQuestions.answerDeliveryStatus, 'failed')
        )
      )
    if (!candidate) return null
    await opts.testHooks?.beforeAgentScopeLock?.()
    if (!(await lockExpectedAgent(tx, candidate.agentId, opts.expectedAgentScope, 'addressable'))) return null
    const [row] = await tx.select().from(agentQuestions).where(eq(agentQuestions.id, id)).for('update')
    if (!row || row.status !== 'answered' || row.answerDeliveryStatus !== 'failed') return null
    const [next] = await tx
      .update(agentQuestions)
      .set({
        answerDeliveryStatus: 'pending',
        answerDeliveryGeneration: row.answerDeliveryGeneration + 1,
        answerDeliveryAttemptCount: 0,
        answerDeliveryNextAttemptAt: new Date(),
        answerDeliveryClaimToken: null,
        answerDeliveryClaimedAt: null,
        answerDeliveryLastError: null,
      })
      .where(
        and(
          eq(agentQuestions.id, id),
          eq(agentQuestions.answerDeliveryStatus, 'failed'),
          eq(agentQuestions.answerDeliveryGeneration, row.answerDeliveryGeneration)
        )
      )
      .returning()
    return next ?? null
  })
  if (!updated) return null
  eventEmitter.emit('agent-question.delivery-retrying', {
    questionId: updated.id,
    agentId: updated.agentId,
    squadId: updated.squadId,
  })
  drainQuestionAnswerDeliverySoon(updated.id)
  return toJson(updated)
}

/**
 * Answer an open question: record the answer and deliver it to the asking agent as an inbox message
 * (which wakes the agent). Idempotent — returns null if the question is missing or already answered.
 */
export async function answerAgentQuestion(
  id: string,
  answer: string,
  answeredByUserId: string,
  opts: {
    expectedAgentScope?: ExpectedAgentScope
    testHooks?: {
      duringWaitClose?: () => Promise<void>
      beforeAnswerCommit?: () => Promise<void>
      beforeAgentScopeLock?: () => Promise<void>
    }
  } = {}
): Promise<AgentQuestion | null> {
  // The answer write and the question-wait close are ONE transaction: an
  // aborted wait-close rolls back the answer, so an answered-but-still-
  // waiting state cannot exist.
  const result = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ agentId: agentQuestions.agentId })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, 'open')))
    if (!candidate) return null
    await opts.testHooks?.beforeAgentScopeLock?.()
    if (!(await lockExpectedAgent(tx, candidate.agentId, opts.expectedAgentScope, 'addressable'))) return null
    const [question] = await tx
      .select()
      .from(agentQuestions)
      .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, 'open')))
      .for('update')
    if (!question) return null
    const openWaitRows = await tx
      .select({ workStreamId: workStreamWaits.workStreamId })
      .from(workStreamWaits)
      .where(
        and(eq(workStreamWaits.referenceId, id), eq(workStreamWaits.type, 'question'), isNull(workStreamWaits.closedAt))
      )
    const locked = await lockWorkStreams(
      tx,
      openWaitRows.map(({ workStreamId }) => workStreamId)
    )
    const answeredAt = new Date()
    const [updated] = await tx
      .update(agentQuestions)
      .set({
        status: 'answered',
        answer,
        answeredByUserId,
        answeredAt,
        answerDeliveryStatus: 'pending',
        answerDeliveryGeneration: 1,
        answerDeliveryAttemptCount: 0,
        answerDeliveryNextAttemptAt: answeredAt,
        answerDeliveryClaimToken: null,
        answerDeliveryClaimedAt: null,
        answerDeliveryLastError: null,
      })
      .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, 'open')))
      .returning()
    if (!updated) return null
    // Deterministic failure boundary for the same-transaction test: a throw
    // here stands in for a failed wait-close and must roll back the answer.
    if (opts.testHooks?.duringWaitClose) await opts.testHooks.duringWaitClose()
    const closedWaits = await closeOpenWaits(tx, { type: 'question', referenceId: id }, 'answered')
    const closedIds = new Set(closedWaits.map((wait) => wait.workStreamId))
    const changedWorkStreams = locked.filter((stream) => closedIds.has(stream.id))
    await resetChangedContinuations(tx, changedWorkStreams)
    await opts.testHooks?.beforeAnswerCommit?.()
    return { updated, closedWaits, changedWorkStreams }
  })
  if (!result) return null
  const { updated: row, closedWaits, changedWorkStreams } = result
  emitChangedWorkStreams(changedWorkStreams)

  // Wait resolution never changes status by itself, but a now-admissible
  // queued stream should compete promptly — run promotion best-effort after invalidation.
  if (closedWaits.length > 0) await promoteChangedWorkStreams(changedWorkStreams, 'Post-answer')

  eventEmitter.emit('agent-question.answered', { questionId: row.id, agentId: row.agentId, squadId: row.squadId })

  drainQuestionAnswerDeliverySoon(row.id)
  return toJson(row)
}

export type QuestionDismissedBy = { type: 'user'; userId: string } | { type: 'agent'; agentId: string }

/**
 * Dismiss an open question without answering it. Its question waits close as cleared, and nothing
 * is delivered to the asking agent. The operation works regardless of the asking agent's lifecycle
 * state and returns null when the question is missing or no longer open.
 */
export async function dismissAgentQuestion(
  id: string,
  opts: {
    dismissedBy: QuestionDismissedBy
    reason?: string
    expectedAgentScope?: ExpectedAgentScope
    testHooks?: { duringWaitClose?: () => Promise<void>; beforeAgentScopeLock?: () => Promise<void> }
  }
): Promise<AgentQuestion | null> {
  const kind = opts.dismissedBy.type === 'agent' ? 'agent-dismissed' : 'user-dismissed'
  const trimmedReason = opts.reason?.trim()
  const dismissalReason = (trimmedReason ? `${kind}: ${trimmedReason}` : kind).slice(0, 256)

  const result = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ agentId: agentQuestions.agentId })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, 'open')))
    if (!candidate) return null
    await opts.testHooks?.beforeAgentScopeLock?.()
    if (!(await lockExpectedAgent(tx, candidate.agentId, opts.expectedAgentScope, 'any'))) return null

    const [question] = await tx
      .select()
      .from(agentQuestions)
      .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, 'open')))
      .for('update')
    if (!question) return null

    const openWaitRows = await tx
      .select({ workStreamId: workStreamWaits.workStreamId })
      .from(workStreamWaits)
      .where(
        and(eq(workStreamWaits.referenceId, id), eq(workStreamWaits.type, 'question'), isNull(workStreamWaits.closedAt))
      )
    const locked = await lockWorkStreams(
      tx,
      openWaitRows.map(({ workStreamId }) => workStreamId)
    )
    const [updated] = await tx
      .update(agentQuestions)
      .set({
        status: 'dismissed',
        dismissedAt: new Date(),
        dismissalReason,
        dismissedByUserId: opts.dismissedBy.type === 'user' ? opts.dismissedBy.userId : null,
        dismissedByAgentId: opts.dismissedBy.type === 'agent' ? opts.dismissedBy.agentId : null,
      })
      .where(and(eq(agentQuestions.id, id), eq(agentQuestions.status, 'open')))
      .returning()
    if (!updated) return null

    await opts.testHooks?.duringWaitClose?.()
    const closedWaits = await closeOpenWaits(tx, { type: 'question', referenceId: id }, 'cleared')
    const closedIds = new Set(closedWaits.map((wait) => wait.workStreamId))
    const changedWorkStreams = locked.filter((stream) => closedIds.has(stream.id))
    await resetChangedContinuations(tx, changedWorkStreams)
    return { updated, closedWaits, changedWorkStreams }
  })
  if (!result) return null

  const { updated, closedWaits, changedWorkStreams } = result
  emitChangedWorkStreams(changedWorkStreams)
  if (closedWaits.length > 0) await promoteChangedWorkStreams(changedWorkStreams, 'Post-dismiss')
  eventEmitter.emit('agent-question.dismissed', {
    questionId: updated.id,
    agentId: updated.agentId,
    squadId: updated.squadId,
  })
  return toJson(updated)
}
