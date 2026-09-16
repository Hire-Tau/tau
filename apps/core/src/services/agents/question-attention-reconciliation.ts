import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
  agentQuestionRecipients,
  agentQuestionWorkStreamOrigins,
  agentQuestions,
  executions,
  messages,
  workStreams,
} from '../../db/schema'
import { isUuid, listTrustedWorkStreamOriginsForExecution } from '../work-streams/execution-provenance'
import { listWorkStreamSubscriberIds } from '../work-streams/subscriptions'
import { hasUserPermissionWithExecutor } from '../rbac'
import { listAgentQuestionAttentionUserIds } from './questions'
import { listEnabledUserIds } from '../users/enabled'

export interface QuestionAttentionReconciliationOptions {
  executor?: typeof db
  limit?: number
  /** Optional bounded scope for isolated repair runs and tests. */
  candidateQuestionIds?: readonly string[]
}

function parsedConsumedAt(metadata: Record<string, unknown> | null): Date | null {
  if (typeof metadata?.consumedAt !== 'string') return null
  const value = new Date(metadata.consumedAt)
  return Number.isNaN(value.getTime()) ? null : value
}

/**
 * Repair legacy open questions whose attention audience was never durably
 * resolved (resolution null/pending and no denormalized owner). For each, the
 * trusted execution/origin evidence is replayed to backfill recipients and
 * origins, resolving the audience when some authorized human can reach the
 * question and marking it `legacy-unresolved` otherwise. An unresolved audience is a routing state,
 * not a failure: the question stays visible and answerable, and no
 * system-inbox notice is sent for it.
 */
export async function reconcileAgentQuestionAttentionOnce(
  options: QuestionAttentionReconciliationOptions = {}
): Promise<{ processed: number; resolved: number; unresolved: number }> {
  const executor = options.executor ?? db
  const candidates = await executor
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.status, 'open'),
        isNull(agentQuestions.ownerUserId),
        or(isNull(agentQuestions.audienceResolution), eq(agentQuestions.audienceResolution, 'pending')),
        options.candidateQuestionIds ? inArray(agentQuestions.id, [...options.candidateQuestionIds]) : undefined
      )
    )
    .orderBy(asc(agentQuestions.createdAt), asc(agentQuestions.id))
    .limit(options.limit ?? 100)

  let resolved = 0
  let unresolved = 0
  for (const question of candidates) {
    const executionCandidates = question.executionId
      ? await executor
          .select()
          .from(executions)
          .where(and(eq(executions.id, question.executionId), eq(executions.agentId, question.agentId)))
      : await executor
          .select()
          .from(executions)
          .where(
            and(
              eq(executions.agentId, question.agentId),
              lte(executions.startedAt, question.createdAt),
              or(isNull(executions.endedAt), gte(executions.endedAt, question.createdAt))
            )
          )

    const execution = executionCandidates.length === 1 ? executionCandidates[0] : null
    const recipientIds = new Set<string>()
    const originIds: string[] = []
    if (execution) {
      const rows = await executor
        .select({ pending: messages.pending, metadata: messages.metadata })
        .from(messages)
        .where(
          and(
            eq(messages.agentId, question.agentId),
            eq(messages.role, 'human'),
            sql`${messages.metadata}->>'executionId' = ${execution.id}`
          )
        )
      for (const row of rows) {
        const metadata = row.metadata as Record<string, unknown> | null
        const sender = metadata?.sender as { userId?: unknown } | undefined
        const consumedAt = parsedConsumedAt(metadata)
        if (
          !row.pending &&
          metadata?.source === 'user_chat' &&
          isUuid(sender?.userId) &&
          consumedAt &&
          consumedAt <= question.createdAt
        ) {
          recipientIds.add(sender.userId)
        }
      }
      const origins = await listTrustedWorkStreamOriginsForExecution(executor, {
        agentId: question.agentId,
        executionId: execution.id,
      })
      const originMessageIds = origins.flatMap(({ messageIds }) => messageIds)
      const consumedOriginIds = new Set<string>()
      if (originMessageIds.length > 0) {
        const originMessages = await executor
          .select({ id: messages.id, pending: messages.pending, metadata: messages.metadata })
          .from(messages)
          .where(inArray(messages.id, originMessageIds))
        for (const row of originMessages) {
          const consumedAt = parsedConsumedAt(row.metadata as Record<string, unknown> | null)
          if (!row.pending && consumedAt && consumedAt <= question.createdAt) consumedOriginIds.add(row.id)
        }
      }
      for (const origin of origins) {
        if (origin.messageIds.some((id) => consumedOriginIds.has(id))) originIds.push(origin.workStreamId)
      }
      if (originIds.length > 0) {
        const streams = await executor
          .select({ requestingUserId: workStreams.requestingUserId })
          .from(workStreams)
          .where(inArray(workStreams.id, originIds))
        for (const { requestingUserId } of streams) if (requestingUserId) recipientIds.add(requestingUserId)
      }
    }

    const enabledIds = new Set(await listEnabledUserIds([...recipientIds], executor))

    // Subscription rows on the origin streams are a CANDIDATE SIGNAL for routability, not an
    // attention entitlement: they are collected at any level (a `mute` row counts here) because
    // what is being decided is whether anyone can reach this question at all, not who gets
    // interrupted about it. Visibility is permission-shaped, so the candidates are narrowed by
    // `actions:read` below; attention levels only decide notification, and are applied by the
    // notify-time resolvers, never here.
    const originSubscriberIds = (
      await Promise.all(originIds.map((workStreamId) => listWorkStreamSubscriberIds(workStreamId, executor)))
    ).flat()
    const enabledOriginSubscribers = await listEnabledUserIds(originSubscriberIds, executor)
    const authorizedOriginSubscriberIds = question.squadId
      ? await Promise.all(
          enabledOriginSubscribers.map(async (id) =>
            (await hasUserPermissionWithExecutor(executor, id, 'actions:read', question.squadId ?? undefined))
              ? id
              : null
          )
        )
      : []
    // "Is this question reachable by some authorized human?" — the routing question, not "who is
    // notified?".
    const hasRoutableAudience =
      enabledIds.size > 0 ||
      authorizedOriginSubscriberIds.some(Boolean) ||
      (executor === db && (await listAgentQuestionAttentionUserIds(question.id)).length > 0)
    const outcome = await executor.transaction(async (tx): Promise<'resolved' | 'unresolved' | null> => {
      const [current] = await tx
        .select({
          status: agentQuestions.status,
          resolution: agentQuestions.audienceResolution,
        })
        .from(agentQuestions)
        .where(eq(agentQuestions.id, question.id))
        .for('update')
      if (!current || current.status !== 'open') return null
      if (![null, 'pending'].includes(current.resolution)) return null

      if (enabledIds.size > 0) {
        await tx
          .insert(agentQuestionRecipients)
          .values(
            [...enabledIds].map((userId) => ({
              questionId: question.id,
              userId,
              reason: 'legacy-repair' as const,
            }))
          )
          .onConflictDoNothing()
      }
      if (originIds.length > 0) {
        await tx
          .insert(agentQuestionWorkStreamOrigins)
          .values(originIds.map((workStreamId) => ({ questionId: question.id, workStreamId })))
          .onConflictDoNothing()
      }

      if (execution && hasRoutableAudience) {
        await tx
          .update(agentQuestions)
          .set({
            executionId: execution.id,
            audienceResolution: 'resolved',
            audienceResolvedAt: new Date(),
          })
          .where(eq(agentQuestions.id, question.id))
        return 'resolved'
      }

      await tx
        .update(agentQuestions)
        .set({ audienceResolution: 'legacy-unresolved', audienceResolvedAt: new Date() })
        .where(eq(agentQuestions.id, question.id))
      return 'unresolved'
    })

    if (outcome === 'resolved') {
      resolved += 1
    } else if (outcome === 'unresolved') {
      unresolved += 1
    }
  }

  return { processed: candidates.length, resolved, unresolved }
}
