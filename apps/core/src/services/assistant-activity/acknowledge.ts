import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { assistantUpdates, db } from '../../db'
import { ownedConversation } from './read'

export type MarkSeenResult = { ok: true } | { ok: false; reason: 'not-found' | 'invalid-ids' }

/**
 * Record human acknowledgment. Idempotent, owner-scoped, and independent of Realtime processing:
 * seeing an update never marks it processed and processing never marks it seen. A batch with any
 * ID outside the conversation is rejected whole so a client cannot probe other mailboxes.
 */
export async function markAssistantUpdatesSeen(
  ownerUserId: string,
  conversationId: string,
  selection: { messageIds: string[] } | { throughSequence: number }
): Promise<MarkSeenResult> {
  const conversation = await ownedConversation(ownerUserId, conversationId)
  if (!conversation) return { ok: false, reason: 'not-found' }
  return db.transaction(async (tx) => {
    if ('messageIds' in selection) {
      const ids = [...new Set(selection.messageIds)]
      const owned = await tx
        .select({ id: assistantUpdates.messageId })
        .from(assistantUpdates)
        .where(and(eq(assistantUpdates.conversationId, conversationId), inArray(assistantUpdates.messageId, ids)))
      if (owned.length !== ids.length) return { ok: false, reason: 'invalid-ids' }
      await tx
        .update(assistantUpdates)
        .set({ seenAt: sql`now()` })
        .where(
          and(
            eq(assistantUpdates.conversationId, conversationId),
            inArray(assistantUpdates.messageId, ids),
            isNull(assistantUpdates.seenAt)
          )
        )
    } else {
      // Only the displayed snapshot is acknowledged; later sequences stay unread.
      await tx
        .update(assistantUpdates)
        .set({ seenAt: sql`now()` })
        .where(
          and(
            eq(assistantUpdates.conversationId, conversationId),
            lte(assistantUpdates.sequence, selection.throughSequence),
            isNull(assistantUpdates.seenAt)
          )
        )
    }
    return { ok: true }
  })
}
