import { and, eq, isNull } from 'drizzle-orm'
import type { AssistantEditorState } from '@tau/shared'
import { assistantConversationAgents, assistantConversations, db } from '../db'
import { Agent } from '../entities/Agent'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const UNAVAILABLE = new Set(['dormant', 'terminated'])

function scopeFilter(conversationId: string, squadId: string | null) {
  return and(
    eq(assistantConversationAgents.conversationId, conversationId),
    squadId === null ? isNull(assistantConversationAgents.squadId) : eq(assistantConversationAgents.squadId, squadId)
  )
}

/**
 * Find or lazily create the agent a conversation owns for one scope: the general helper
 * (squadId null, a system-manager with the owner's permissions) or one consultant per squad.
 * Call inside the caller's transaction after locking the conversation row; that lock is what
 * serializes concurrent first delegations. A dormant or terminated owned agent is replaced.
 */
export async function resolveOwnedAgent(
  tx: Tx,
  conversation: { id: string; ownerUserId: string },
  target: { squadId: string | null }
): Promise<Agent> {
  const [row] = await tx
    .select({ agentId: assistantConversationAgents.agentId })
    .from(assistantConversationAgents)
    .where(scopeFilter(conversation.id, target.squadId))
  if (row) {
    const existing = await Agent.find(row.agentId)
    if (existing && !UNAVAILABLE.has(existing.status)) return existing
    await tx.delete(assistantConversationAgents).where(scopeFilter(conversation.id, target.squadId))
  }
  const agent =
    target.squadId === null
      ? await Agent.create({
          agentTypeId: 'system-manager',
          ownerUserId: conversation.ownerUserId,
          context: { scope: { type: 'system-manager' } },
        })
      : await Agent.create({
          agentTypeId: 'consultant',
          squadId: target.squadId,
          name: 'Assistant task',
          context: { scope: { type: 'consultant', id: target.squadId } },
          persist: false,
        })
  await tx
    .insert(assistantConversationAgents)
    .values({ conversationId: conversation.id, squadId: target.squadId, agentId: agent.id })
  return agent
}

/** The conversation whose general helper this agent is. Consultants never own a page editor. */
export async function findOwningConversation(
  agentId: string
): Promise<{ id: string; editor: AssistantEditorState | null } | undefined> {
  const [row] = await db
    .select({ id: assistantConversations.id, editor: assistantConversations.editor })
    .from(assistantConversationAgents)
    .innerJoin(assistantConversations, eq(assistantConversations.id, assistantConversationAgents.conversationId))
    .where(and(eq(assistantConversationAgents.agentId, agentId), isNull(assistantConversationAgents.squadId)))
    .limit(1)
  return row
}
