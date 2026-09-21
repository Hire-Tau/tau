import { and, eq, isNull } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { agents, assistantConversations, db, users } from '../db'
import { Agent } from '../entities/Agent'
import { eventEmitter } from '../lib/infra/event-emitter'
import { requireAssistantConversation } from './assistant-task-requests'
import type { Identity } from './rbac'

/** A nullable binding upgrades a legacy conversation without rewriting its transcript or helpers. */
export async function ensureAssistantConversationAgent(identity: Identity | undefined, conversationId: string) {
  const { user } = await requireAssistantConversation(identity, conversationId)
  let created = false
  const agent = await db.transaction(async (tx) => {
    // User then conversation: revocation/deletion and concurrent first channels have durable fences.
    const [owner] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, user.userId), isNull(users.disabledAt)))
      .for('share')
    if (!owner) throw new HTTPException(403, { message: 'Forbidden' })
    const [conversation] = await tx
      .select()
      .from(assistantConversations)
      .where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.ownerUserId, user.userId)))
      .for('update')
    if (!conversation) throw new HTTPException(404, { message: 'Conversation not found' })
    if (conversation.agentId) {
      const [existing] = await tx.select().from(agents).where(eq(agents.id, conversation.agentId))
      if (!existing || existing.status === 'terminated' || existing.pendingDormancyAt)
        throw new HTTPException(409, { message: 'This Assistant is unavailable. Start a new conversation.' })
      if (existing.ownerUserId !== user.userId || existing.squadId || existing.agentTypeId !== 'assistant')
        throw new HTTPException(409, { message: 'Conversation binding is invalid' })
      return new Agent(existing)
    }
    const [row] = await tx
      .insert(agents)
      .values({
        agentTypeId: 'assistant',
        ownerUserId: user.userId,
        squadId: null,
        persist: false,
        context: { scope: { type: 'system-manager' } },
        metadata: { name: 'Assistant', purpose: conversation.title, resourceGeneration: crypto.randomUUID() },
      })
      .returning()
    await tx
      .update(assistantConversations)
      .set({ agentId: row!.id })
      .where(eq(assistantConversations.id, conversationId))
    created = true
    return new Agent(row!)
  })
  if (created) eventEmitter.emit('agent.created', { agentId: agent.id, squadId: null })
  return { agentId: agent.id }
}
