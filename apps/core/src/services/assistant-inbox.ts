import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { parseAssistantInboxConversationId } from '@tau/shared'
import { assistantConversations, db, inbox } from '../db'

export async function assistantInboxOwner(recipientId: string): Promise<string | null> {
  const id = parseAssistantInboxConversationId(recipientId)
  if (!id) return null
  const [conversation] = await db
    .select({ owner: assistantConversations.ownerUserId })
    .from(assistantConversations)
    .where(eq(assistantConversations.id, id))
  return conversation?.owner ?? null
}

/** Agents may reply only to an Assistant conversation that actually contacted them. */
export async function validateAssistantInboxReply(
  recipientId: string,
  senderType: string,
  senderId: string | null | undefined,
  replyTo: unknown
): Promise<void> {
  if (senderType !== 'system' && !z.string().uuid().safeParse(replyTo).success)
    throw new Error('inReplyTo must be a full inbox message UUID')
  if (!(await assistantInboxOwner(recipientId))) throw new Error('Assistant conversation not found')
  if (senderType === 'system') return
  if (senderType !== 'agent' || !senderId)
    throw new Error('Assistant inbox replies can only be sent by a contacted agent')
  const [request] = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(
      and(
        eq(inbox.senderType, 'voice_assistant'),
        eq(inbox.senderId, recipientId),
        eq(inbox.recipientType, 'agent'),
        eq(inbox.recipientId, senderId),
        typeof replyTo === 'string' ? eq(inbox.id, replyTo) : undefined
      )
    )
    .limit(1)
  if (!request) throw new Error('Assistant inbox replies can only be sent by the recipient of its request')
}
