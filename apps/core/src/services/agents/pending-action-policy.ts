import type { PendingAction, WorkStreamActionData } from '@tau/shared'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '../../db'
import { agentQuestionRecipients, agentQuestionWorkStreamOrigins, agents } from '../../db/schema'
import { hasPermission, type Identity } from '../rbac'
import { activeWorkflowAttempts } from '@tau/shared'
import { workStreamFlowRuns, workStreams } from '../../db'
import { isWorkflowReviewer } from '../workflows/reviewers'
import { canAnswerAgentQuestion } from './question-authorization'

export interface PendingActionAttentionContext {
  watchedSquadIds: ReadonlySet<string>
  watchedWorkStreamIds: ReadonlySet<string>
}

export interface PendingActionPolicyDecision {
  visible: boolean
  canRespond: boolean
}

async function isDirectQuestionAttentionRecipient(questionId: string, userId: string): Promise<boolean> {
  const [recipient] = await db
    .select({ userId: agentQuestionRecipients.userId })
    .from(agentQuestionRecipients)
    .where(and(eq(agentQuestionRecipients.questionId, questionId), eq(agentQuestionRecipients.userId, userId)))
  return Boolean(recipient)
}

async function watchesQuestionOrigin(questionId: string, watchedIds: ReadonlySet<string>): Promise<boolean> {
  if (watchedIds.size === 0) return false
  const origins = await db
    .select({ workStreamId: agentQuestionWorkStreamOrigins.workStreamId })
    .from(agentQuestionWorkStreamOrigins)
    .where(eq(agentQuestionWorkStreamOrigins.questionId, questionId))
  return origins.some(({ workStreamId }) => watchedIds.has(workStreamId))
}

/**
 * Action Center/push ATTENTION policy for an agent question. Direct attention recipients
 * (durable rows) and compatible squadless personal owners receive the action without any
 * subscription; authorized squad/work-stream watchers receive it with `actions:read`. This is
 * deliberately NOT chat/history readability — that follows canonical agents:read on the agent
 * (see routes/agent-questions.ts).
 */
export async function canReceiveAgentQuestionAttention(
  identity: Identity,
  question: { id: string; ownerUserId: string | null; squadId: string | null },
  context: PendingActionAttentionContext
): Promise<boolean> {
  const userId = identity.type === 'user' ? identity.userId : null
  // Only a squadless personal agent's owner bypasses subscriptions; a squad-bound agent's
  // owner snapshot is metadata, not an attention entitlement.
  const owner = Boolean(userId && question.ownerUserId === userId && !question.squadId)
  const direct = Boolean(userId && (await isDirectQuestionAttentionRecipient(question.id, userId)))
  const canRead = await hasPermission(identity, 'actions:read', question.squadId ?? undefined)
  const watchedSquad = Boolean(question.squadId && context.watchedSquadIds.has(question.squadId))
  const watchedOrigin = await watchesQuestionOrigin(question.id, context.watchedWorkStreamIds)
  return owner || direct || (canRead && (watchedSquad || watchedOrigin || identity.type !== 'user'))
}

export async function evaluatePendingAction(
  identity: Identity,
  action: PendingAction,
  context: PendingActionAttentionContext
): Promise<PendingActionPolicyDecision> {
  const userId = identity.type === 'user' ? identity.userId : null
  const squadId = action.squadId
  const watchedSquad = Boolean(squadId && context.watchedSquadIds.has(squadId))
  const canRead = await hasPermission(identity, 'actions:read', squadId)

  if (action.type === 'agent-question') {
    const data = action.data as {
      agentId: string
      questionId: string
      ownerUserId: string | null
      squadId: string | null
    }
    return {
      visible: await canReceiveAgentQuestionAttention(
        identity,
        { id: data.questionId, ownerUserId: data.ownerUserId, squadId: data.squadId },
        context
      ),
      canRespond: await canAnswerAgentQuestion(identity, data),
    }
  }

  if (action.type === 'assistant-needs-input') {
    // Private to the conversation owner; squad access or administration never widens it.
    const data = action.data as { ownerUserId: string }
    const owner = Boolean(userId && data.ownerUserId === userId)
    return { visible: owner, canRespond: owner }
  }

  if (action.type === 'agent-error') {
    const data = action.data as { ownerUserId: string | null; squadId: string | null }
    const owner = Boolean(userId && data.ownerUserId === userId)
    return {
      visible: owner || (canRead && (watchedSquad || identity.type !== 'user')),
      canRespond:
        Boolean(!data.squadId && owner) ||
        Boolean(data.squadId && (await hasPermission(identity, 'agents:run', data.squadId))),
    }
  }

  if (action.type === 'squad-question') {
    const data = action.data as { agentId: string }
    const [target] = await db
      .select({ squadId: agents.squadId })
      .from(agents)
      .where(and(eq(agents.id, data.agentId), ne(agents.status, 'terminated')))
    const currentSquadId = target?.squadId ?? null
    if (!currentSquadId) return { visible: false, canRespond: false }
    const currentCanRead = await hasPermission(identity, 'actions:read', currentSquadId)
    const currentWatched = context.watchedSquadIds.has(currentSquadId)
    return {
      visible: currentCanRead && (currentWatched || identity.type !== 'user'),
      canRespond: await hasPermission(identity, 'agents:run', currentSquadId),
    }
  }

  const data = action.data as WorkStreamActionData
  const workStreamId = data.workStreamId
  if (data.wait.resolutionHandler === 'workflow') {
    const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
    const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, workStreamId))
    const attempt = run && activeWorkflowAttempts(run.state).find((a) => a.id === data.wait.flowAttemptId)
    const step = attempt?.step ?? run?.state.definition.steps.find((s) => s.id === attempt?.stepId)
    let canRespond = false
    if (identity.type === 'user' && squadId && stream && run?.activated) {
      if (step?.kind === 'human-approval')
        canRespond =
          (await isWorkflowReviewer(identity.userId, squadId)) &&
          (step.approver !== 'assigned-reviewers' ||
            !stream.assignedReviewerIds.length ||
            stream.assignedReviewerIds.includes(identity.userId))
      else if (run.state.status === 'completion-ready' && run.state.definition.completion.mode === 'review-approval')
        canRespond =
          (await hasPermission(identity, 'workstreams:respond', squadId)) ||
          (await hasPermission(identity, 'workstreams:update', squadId))
      else canRespond = await hasPermission(identity, 'workstreams:revise-flow', squadId)
    }
    return {
      visible: canRead && (identity.type !== 'user' || watchedSquad || context.watchedWorkStreamIds.has(workStreamId)),
      canRespond,
    }
  }
  return {
    visible: canRead && (identity.type !== 'user' || watchedSquad || context.watchedWorkStreamIds.has(workStreamId)),
    canRespond: Boolean(
      squadId &&
      ((await hasPermission(identity, 'workstreams:respond', squadId)) ||
        (await hasPermission(identity, 'workstreams:update', squadId)))
    ),
  }
}
