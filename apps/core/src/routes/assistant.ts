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
import { and, asc, desc, eq, ilike, isNull, notInArray, sql } from 'drizzle-orm'
import {
  ASSISTANT_CONVERSATION_KINDS,
  assistantEntrySchema,
  assistantInboxRecipientId,
  chatPagePathSchema,
  type AssistantEntry,
  type AssistantMailbox,
  type AssistantMessageReceipt,
} from '@tau/shared'
import {
  assistantConversationAgents,
  assistantConversations,
  assistantEntries,
  assistantTasks,
  assistantUpdates,
  db,
  inbox,
  agents,
} from '../db'
import { ASSISTANT_DELEGATION_KEY, ASSISTANT_TASK_ID_KEY } from '../services/assistant-activity/project'
import { assistantActivityRouter } from './assistant-activity'
import { markAssistantUpdatesProcessed } from '../services/assistant-activity/acknowledge'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { InboxMessage } from '../entities/InboxMessage'
import { resolveOwnedAgent } from '../services/assistant-agents'
import { resolveActingUser, hasAgentResourcePermission, hasPermission } from '../services/rbac'
import { requirePermission } from '../middleware/require-permission'

const uuid = z.string().uuid()
const createSchema = z.object({
  id: uuid,
  title: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(ASSISTANT_CONVERSATION_KINDS).default('assistant'),
})
const appendSchema = z.object({ entries: z.array(assistantEntrySchema).min(1).max(50) })
const messageSchema = z
  .object({
    clientId: uuid,
    request: z.string().trim().min(1).max(20_000),
    pagePath: chatPagePathSchema.optional(),
    agentId: uuid.optional(),
    squadId: uuid.optional(),
    label: z.string().trim().min(1).max(80).optional(),
    inReplyTo: uuid.optional(),
    mode: z.enum(['steer', 'follow-up']).default('steer'),
  })
  .refine((input) => !(input.agentId && input.squadId), { message: 'agentId and squadId are mutually exclusive' })

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
            query ? ilike(assistantConversations.title, `%${query.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
            // Page-editor conversations belong to their page, not the app-wide Assistant, and empty
            // shells (unused drafts) are not conversations yet.
            eq(assistantConversations.kind, 'assistant'),
            sql`(EXISTS (SELECT 1 FROM ${assistantEntries} WHERE ${assistantEntries.conversationId} = ${assistantConversations.id})
              OR EXISTS (SELECT 1 FROM ${assistantTasks} WHERE ${assistantTasks.conversationId} = ${assistantConversations.id}))`
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
  // Activity discovery registers before `/:id` so `/activity` is never read as a conversation ID.
  .route('/', assistantActivityRouter)
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
    // Validate replies before resolving or creating a helper. A reply always addresses its actual
    // sender, even if that helper has since become dormant or its scope has been replaced.
    const [reply] = input.inReplyTo
      ? await db
          .select({ senderId: inbox.senderId })
          .from(inbox)
          .where(
            and(
              eq(inbox.id, input.inReplyTo),
              eq(inbox.recipientType, 'voice_assistant'),
              eq(inbox.recipientId, address),
              eq(inbox.senderType, 'agent')
            )
          )
      : []
    const replyAgentId = reply?.senderId
    if (input.inReplyTo && (!replyAgentId || (input.agentId && replyAgentId !== input.agentId)))
      return c.json({ error: 'Reply not found in this conversation' }, 404)
    let agent: Agent | null
    let kind: AssistantMessageReceipt['kind']
    let targetSquadId: string | null = null
    if (input.agentId) {
      agent = await Agent.find(input.agentId)
      if (!agent || !(await hasAgentResourcePermission(c.get('identity'), agent, 'chat:send')))
        return c.json({ error: 'Agent not found' }, 404)
      kind = 'agent'
    } else {
      let squadId = input.squadId ?? null
      if (replyAgentId) {
        const [ownedAgent] = await db
          .select({ squadId: assistantConversationAgents.squadId })
          .from(assistantConversationAgents)
          .where(
            and(
              eq(assistantConversationAgents.conversationId, conversation.id),
              eq(assistantConversationAgents.agentId, replyAgentId)
            )
          )
        if (!ownedAgent)
          return c.json({ error: 'This task helper is no longer attached. Start a new task without inReplyTo.' }, 409)
        if (input.squadId && input.squadId !== ownedAgent.squadId)
          return c.json({ error: 'Reply not found in this conversation' }, 404)
        squadId = ownedAgent.squadId
      }
      // Explicit scopes and reply-inferred scopes pass through the same current authorization check.
      if (squadId) {
        const squad = await Squad.find(squadId)
        if (!squad || squad.status !== 'active' || !(await hasPermission(c.get('identity'), 'chat:send', squad.id)))
          return c.json({ error: 'Squad not found' }, 404)
      }
      targetSquadId = squadId
      const afterCommit: Array<() => void> = []
      agent = replyAgentId
        ? await Agent.find(replyAgentId)
        : await db.transaction(async (tx) => {
            await tx
              .select({ id: assistantConversations.id })
              .from(assistantConversations)
              .where(eq(assistantConversations.id, conversation.id))
              .for('update')
            return resolveOwnedAgent(tx, conversation, { squadId }, afterCommit)
          })
      for (const emit of afterCommit) emit()
      kind = squadId ? 'squad' : 'background'
    }
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    if (replyAgentId && agent.status === 'terminated')
      return c.json({ error: 'This task helper was terminated. Start a new task without inReplyTo.' }, 409)
    const agentId = agent.id
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
          [ASSISTANT_DELEGATION_KEY]: { kind, squadId: targetSquadId, ...(input.label ? { label: input.label } : {}) },
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
    if (input.label && kind !== 'agent') await agent.update({ purpose: `Assistant task: ${input.label}` })
    const taskId = message.metadata[ASSISTANT_TASK_ID_KEY]
    if (typeof taskId !== 'string') return c.json({ error: 'Task receipt unavailable' }, 500)
    const receipt: AssistantMessageReceipt = {
      id: message.id,
      taskId,
      agentId,
      delivered: Boolean(message.deliveredAt),
      kind,
      ...(kind === 'squad' && targetSquadId ? { squadId: targetSquadId } : {}),
    }
    return c.json(receipt)
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
    // Unprocessed means Realtime has not presented it; it says nothing about whether the human saw it.
    const incoming = await db
      .select({ update: assistantUpdates, inbox })
      .from(assistantUpdates)
      .innerJoin(inbox, eq(inbox.id, assistantUpdates.messageId))
      .where(and(eq(assistantUpdates.conversationId, conversation.id), isNull(assistantUpdates.processedAt)))
      .orderBy(asc(assistantUpdates.sequence))
      .limit(50)
    // A task stays pending until its delegate explicitly finishes it; progress replies do not end it.
    const pending = await db
      .select({ id: assistantTasks.id, status: agents.status })
      .from(assistantTasks)
      .leftJoin(agents, eq(agents.id, assistantTasks.agentId))
      .where(
        and(
          eq(assistantTasks.conversationId, conversation.id),
          notInArray(assistantTasks.status, ['completed', 'failed', 'cancelled'])
        )
      )
    const mailbox: AssistantMailbox = {
      acquired: true,
      messages: incoming.map(({ update, inbox: message }) => ({
        messageId: message.id,
        taskId: update.taskId,
        requestId: update.requestId,
        sequence: update.sequence,
        reportedStatus: update.reportedStatus,
        content: message.content,
        subject: message.subject,
        senderId: message.senderId,
        senderName:
          (message.metadata.sender as { name?: string; agentTypeName?: string })?.name ||
          (message.metadata.sender as { agentTypeName?: string })?.agentTypeName ||
          'Agent',
        processedAt: null,
        seenAt: update.seenAt?.toISOString() ?? null,
        createdAt: message.createdAt.toISOString(),
      })),
      pending: pending.length,
      unavailable: pending.some((row) => !row.status || row.status === 'terminated'),
    }
    return c.json(mailbox)
  })
  .post(
    '/:id/inbox/ack',
    zValidator(
      'json',
      z.object({
        consumerId: uuid,
        messageIds: z.array(uuid).min(1).max(10),
        responseEntryId: z.string().min(1).max(160),
      })
    ),
    async (c) => {
      const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
      if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
      const result = await markAssistantUpdatesProcessed(conversation.id, c.req.valid('json'))
      return result.ok ? c.json({ success: true }) : c.json({ error: result.message, reason: result.reason }, 409)
    }
  )
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
