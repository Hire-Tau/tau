import { assistantEditorContext } from '@tau/shared'
import {
  syncAssistantEditor,
  readAssistantEditor,
  proposeAssistantEditor,
  closeAssistantEditor,
} from '../services/assistant-editors'
import { assistantEditorSyncSchema, assistantEditorProposalSchema } from '@tau/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { isDeepStrictEqual } from 'node:util'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, ilike, isNull, sql } from 'drizzle-orm'
import { assistantEntrySchema, assistantInboxRecipientId, chatPagePathSchema, type AssistantEntry } from '@tau/shared'
import { assistantConversations, assistantEntries, db, inbox, agents } from '../db'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import { resolveActingUser, hasAgentResourcePermission } from '../services/rbac'
import { requirePermission } from '../middleware/require-permission'

const uuid = z.string().uuid()
const createSchema = z.object({ id: uuid, title: z.string().trim().min(1).max(120).optional() })
const appendSchema = z.object({ entries: z.array(assistantEntrySchema).min(1).max(50) })
const messageSchema = z.object({
  clientId: uuid,
  request: z.string().trim().min(1).max(20_000),
  pagePath: chatPagePathSchema.optional(),
  agentId: uuid.optional(),
  inReplyTo: uuid.optional(),
  mode: z.enum(['steer', 'follow-up']).default('follow-up'),
})

// Every lookup includes the current human owner, including when called by their system manager.
async function owned(id: string, userId: string) {
  if (!uuid.safeParse(id).success) return null
  const [conversation] = await db
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerUserId, userId)))
  return conversation ?? null
}
export const assistantRouter = new Hono<{ Variables: { assistantOwner: string } }>()
  .use('*', requirePermission('chat:send'))
  .use('*', async (c, next) => {
    const user = await resolveActingUser(c.get('identity'))
    if (!user) return c.json({ error: 'Forbidden' }, 403)
    c.set('assistantOwner', user.userId)
    await next()
  })
  .get(
    '/',
    zValidator(
      'query',
      z.object({
        q: z.string().max(120).default(''),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      })
    ),
    async (c) => {
      const { q: query, limit, offset } = c.req.valid('query')
      const rows = await db
        .select()
        .from(assistantConversations)
        .where(
          and(
            eq(assistantConversations.ownerUserId, c.get('assistantOwner')),
            query ? ilike(assistantConversations.title, `%${query.replace(/[\\%_]/g, '\\$&')}%`) : undefined
          )
        )
        .orderBy(desc(assistantConversations.updatedAt), desc(assistantConversations.id))
        .limit(limit + 1)
        .offset(offset)
      return c.json({ conversations: rows.slice(0, limit), hasMore: rows.length > limit })
    }
  )
  .post('/', zValidator('json', createSchema), async (c) => {
    const input = c.req.valid('json')
    await db
      .insert(assistantConversations)
      .values({ ...input, ownerUserId: c.get('assistantOwner') })
      .onConflictDoNothing()
    const row = await owned(input.id, c.get('assistantOwner'))
    if (!row) return c.json({ error: 'Conversation not found' }, 404)
    return c.json(row)
  })
  .get('/:id', zValidator('query', z.object({ before: z.coerce.number().int().positive().optional() })), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    const before = c.req.valid('query').before
    const rows = await db
      .select()
      .from(assistantEntries)
      .where(
        and(
          eq(assistantEntries.conversationId, conversation.id),
          before !== undefined ? sql`${assistantEntries.position} < ${before}` : undefined
        )
      )
      .orderBy(desc(assistantEntries.position))
      .limit(101)
    const history = rows.slice(0, 100).reverse()
    return c.json({
      conversation,
      entries: history.map((row) => row.entry),
      hasMore: rows.length > 100,
      before: history[0]?.position,
    })
  })
  .put('/:id/editor', zValidator('json', assistantEditorSyncSchema), async (c) =>
    c.json(
      await syncAssistantEditor(
        c.req.param('id'),
        { userId: c.get('assistantOwner'), identity: c.get('identity') },
        c.req.valid('json')
      )
    )
  )
  .get('/:id/editor', async (c) =>
    c.json(
      await readAssistantEditor(c.req.param('id'), { userId: c.get('assistantOwner'), identity: c.get('identity') })
    )
  )
  .post('/:id/editor/propose', zValidator('json', assistantEditorProposalSchema), async (c) =>
    c.json(
      await proposeAssistantEditor(
        c.req.param('id'),
        { userId: c.get('assistantOwner'), identity: c.get('identity') },
        c.req.valid('json')
      )
    )
  )
  .delete('/:id/editor', async (c) =>
    c.json(
      await closeAssistantEditor(c.req.param('id'), { userId: c.get('assistantOwner'), identity: c.get('identity') })
    )
  )
  .post('/:id/entries', zValidator('json', appendSchema), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    const input = c.req.valid('json')
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(assistantConversations)
        .where(eq(assistantConversations.id, conversation.id))
        .for('update')
      const [last] = await tx
        .select({ position: assistantEntries.position })
        .from(assistantEntries)
        .where(eq(assistantEntries.conversationId, conversation.id))
        .orderBy(desc(assistantEntries.position))
        .limit(1)
      let position = last?.position ?? 0
      let changed = false
      for (const entry of input.entries) {
        const [previous] = await tx
          .select()
          .from(assistantEntries)
          .where(and(eq(assistantEntries.conversationId, conversation.id), eq(assistantEntries.clientId, entry.id)))
        if (previous) {
          const prior = previous.entry as AssistantEntry
          if (isDeepStrictEqual(prior, entry)) continue
          // Partial entries reserve their place. Completing them cannot rewrite a saved turn's identity.
          if (
            prior.final ||
            !entry.final ||
            prior.role !== entry.role ||
            prior.toolCallId !== entry.toolCallId ||
            prior.toolName !== entry.toolName
          ) {
            throw new HTTPException(409, { message: 'Saved entry conflicts with this request' })
          }
          await tx.update(assistantEntries).set({ entry }).where(eq(assistantEntries.id, previous.id))
        } else {
          await tx
            .insert(assistantEntries)
            .values({ conversationId: conversation.id, clientId: entry.id, position: ++position, entry })
        }
        changed = true
      }
      if (changed) {
        const firstUser = input.entries.find((entry) => entry.role === 'user' && entry.final && entry.text.trim())
        await tx
          .update(assistantConversations)
          .set({
            updatedAt: new Date(),
            ...(locked.title === 'New conversation' && firstUser ? { title: firstUser.text.trim().slice(0, 120) } : {}),
          })
          .where(eq(assistantConversations.id, conversation.id))
      }
    })
    return c.json({ success: true })
  })
  .post('/:id/messages', zValidator('json', messageSchema), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    const input = c.req.valid('json')
    const address = assistantInboxRecipientId(conversation.id)
    const requestContent =
      conversation.editor && !conversation.editor.closed
        ? `${input.request}\n\n${assistantEditorContext(conversation.editor)}\n\n[Page editor conversation: brainstorm or edit the draft using read and edit. Read the latest draft before edits. Do not modify or publish saved presets via CLI or other tools; valid edits apply automatically and can be undone; the user saves to publish.]`
        : input.request
    const agentId =
      input.agentId ??
      (await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select()
          .from(assistantConversations)
          .where(eq(assistantConversations.id, conversation.id))
          .for('update')
        if (fresh.managerAgentId) return fresh.managerAgentId
        const agent = await Agent.create({
          agentTypeId: 'system-manager',
          ownerUserId: conversation.ownerUserId,
          context: { scope: { type: 'system-manager' } },
        })
        await tx
          .update(assistantConversations)
          .set({ managerAgentId: agent.id })
          .where(eq(assistantConversations.id, conversation.id))
        return agent.id
      }))
    const agent = await Agent.find(agentId)
    if (!agent || !(await hasAgentResourcePermission(c.get('identity'), agent, 'chat:send')))
      return c.json({ error: 'Agent not found' }, 404)
    if (input.inReplyTo) {
      const [reply] = await db
        .select({ id: inbox.id })
        .from(inbox)
        .where(
          and(
            eq(inbox.id, input.inReplyTo),
            eq(inbox.recipientType, 'voice_assistant'),
            eq(inbox.recipientId, address),
            eq(inbox.senderType, 'agent'),
            eq(inbox.senderId, agent.id)
          )
        )
      if (!reply) return c.json({ error: 'Reply not found in this conversation' }, 404)
    }
    const history = await db
      .select()
      .from(assistantEntries)
      .where(eq(assistantEntries.conversationId, conversation.id))
      .orderBy(desc(assistantEntries.position))
      .limit(24)
    const [previous] = await db
      .select({ pagePath: sql<string>`${inbox.metadata}->>'pagePath'` })
      .from(inbox)
      .where(
        and(
          eq(inbox.senderType, 'voice_assistant'),
          eq(inbox.senderId, address),
          eq(inbox.recipientId, agentId),
          sql`${inbox.metadata}->>'pagePath' IS NOT NULL`
        )
      )
      .orderBy(desc(inbox.createdAt))
      .limit(1)
    const { message } = await InboxMessage.sendOnce(
      {
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'voice_assistant',
        senderId: address,
        content: requestContent,
        deliveryMode: input.mode,
        metadata: {
          source: 'assistant_inbox',
          inReplyTo: input.inReplyTo,
          ...(input.pagePath && previous?.pagePath !== input.pagePath ? { pagePath: input.pagePath } : {}),
          assistantContext: history.reverse().map(({ entry }) => ({
            role: (entry as AssistantEntry).role,
            text: (entry as AssistantEntry).text.slice(-3000),
          })),
        },
      },
      `${address}:${input.clientId}`
    )
    if (
      message.content !== requestContent ||
      message.recipientId !== agentId ||
      message.deliveryMode !== input.mode ||
      (message.metadata?.inReplyTo ?? undefined) !== input.inReplyTo
    )
      return c.json({ error: 'Message receipt conflicts with this request' }, 409)
    return c.json({ id: message.id, agentId, delivered: Boolean(message.deliveredAt) })
  })
  .post('/:id/inbox', zValidator('json', z.object({ consumerId: uuid })), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    const { consumerId } = c.req.valid('json')
    // One active receiver across devices. DB time owns both lease creation and expiry.
    const [lease] = await db
      .update(assistantConversations)
      .set({
        inboxConsumerId: consumerId,
        inboxConsumerExpiresAt: sql`now() + interval '30 seconds'`,
      })
      .where(
        and(
          eq(assistantConversations.id, conversation.id),
          sql`(
      ${assistantConversations.inboxConsumerId} = ${consumerId} OR
      ${assistantConversations.inboxConsumerExpiresAt} IS NULL OR
      ${assistantConversations.inboxConsumerExpiresAt} <= now()
    )`
        )
      )
      .returning({ id: assistantConversations.id })
    if (!lease) return c.json({ acquired: false, messages: [], pending: 0, unavailable: false })
    const address = assistantInboxRecipientId(conversation.id)
    const incoming = await db
      .select()
      .from(inbox)
      .where(and(eq(inbox.recipientType, 'voice_assistant'), eq(inbox.recipientId, address), isNull(inbox.readAt)))
      .orderBy(asc(inbox.createdAt), asc(inbox.id))
      .limit(50)
    const pending = await db
      .select({ id: inbox.id, status: agents.status })
      .from(inbox)
      .leftJoin(agents, eq(sql`${agents.id}::text`, inbox.recipientId))
      .where(
        and(
          eq(inbox.senderType, 'voice_assistant'),
          eq(inbox.senderId, address),
          eq(inbox.recipientType, 'agent'),
          sql`NOT EXISTS (SELECT 1 FROM inbox reply WHERE reply.recipient_type = 'voice_assistant'
          AND reply.recipient_id = ${address} AND reply.metadata->>'inReplyTo' = ${inbox.id}::text)`
        )
      )
    return c.json({
      acquired: true,
      messages: incoming.map((message) => ({
        id: message.id,
        senderId: message.senderId,
        senderName:
          (message.metadata.sender as { name?: string; agentTypeName?: string })?.name ||
          (message.metadata.sender as { agentTypeName?: string })?.agentTypeName ||
          'Agent',
        content: message.content,
        subject: message.subject,
        replyTo: typeof message.metadata.inReplyTo === 'string' ? message.metadata.inReplyTo : null,
        createdAt: message.createdAt.toISOString(),
      })),
      pending: pending.length,
      unavailable: pending.some((row) => !row.status || row.status === 'terminated'),
    })
  })
  .post('/:id/inbox/ack', zValidator('json', z.object({ consumerId: uuid, messageId: uuid })), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    const input = c.req.valid('json')
    const accepted = await db.transaction(async (tx) => {
      const [lease] = await tx
        .select()
        .from(assistantConversations)
        .where(
          and(
            eq(assistantConversations.id, conversation.id),
            eq(assistantConversations.inboxConsumerId, input.consumerId),
            sql`${assistantConversations.inboxConsumerExpiresAt} > now()`
          )
        )
        .for('update')
      if (!lease) return false
      const [message] = await tx
        .update(inbox)
        .set({ readAt: sql`now()` })
        .where(
          and(
            eq(inbox.id, input.messageId),
            eq(inbox.recipientType, 'voice_assistant'),
            eq(inbox.recipientId, assistantInboxRecipientId(conversation.id))
          )
        )
        .returning({ id: inbox.id })
      return Boolean(message)
    })
    return accepted ? c.json({ success: true }) : c.json({ error: 'Inbox receiver or message unavailable' }, 409)
  })
  .post('/:id/inbox/release', zValidator('json', z.object({ consumerId: uuid })), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    await db
      .update(assistantConversations)
      .set({ inboxConsumerId: null, inboxConsumerExpiresAt: null })
      .where(
        and(
          eq(assistantConversations.id, conversation.id),
          eq(assistantConversations.inboxConsumerId, c.req.valid('json').consumerId)
        )
      )
    return c.json({ success: true })
  })
