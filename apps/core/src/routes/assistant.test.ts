import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  assistantConversations,
  assistantConversationAgents,
  assistantEntries,
  assistantTasks,
  assistantUpdates,
  agents,
  db,
  executions,
  inbox,
  squads,
} from '../db'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { InboxMessage, formatInboxMessages, setBeforeRecipientLifecycleLockHookForTest } from '../entities/InboxMessage'
import { assistantInboxRecipientId } from '@tau/shared'
import { inboxRouter } from './inbox'
import { assistantTasksRouter } from './assistant-tasks'
import { identityMiddleware } from '../middleware/identity'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestRole,
  createTestUser,
  createTestAgentToken,
} from '../test-utils'
import { assistantRouter } from './assistant'
const prefix = `assistant-${randomUUID()}`
const conversationIds: string[] = [],
  agentIds: string[] = [],
  squadIds: string[] = []
const app = new Hono()
  .use('*', identityMiddleware)
  .route('/api/assistant', assistantRouter)
  .route('/api/assistant-tasks', assistantTasksRouter)
  .route('/api/inbox', inboxRouter)
const entry = (id: string, text: string, final = true) => ({ id, text, final, role: 'user' as const })
async function fixture() {
  const owner = await createTestUser({ prefix }),
    other = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  for (const user of [owner, other]) await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })
  const id = randomUUID()
  conversationIds.push(id)
  const request = (path: string, body?: unknown, token = owner.token) =>
    app.request(`/api/assistant${path === '/' ? '' : path.startsWith('/?') ? path.slice(1) : path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  expect((await request('/', { id })).status).toBe(200)
  return { id, owner, other, request }
}
afterEach(async () => {
  if (conversationIds.length)
    await db
      .delete(inbox)
      .where(
        or(
          inArray(inbox.senderId, conversationIds.map(assistantInboxRecipientId)),
          inArray(inbox.recipientId, conversationIds.map(assistantInboxRecipientId))
        )
      )
  if (conversationIds.length)
    await db.delete(assistantConversations).where(inArray(assistantConversations.id, conversationIds.splice(0)))
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds.splice(0)))
  await cleanupTestRbac(prefix)
})
test('saved histories belong to their user; guessed IDs cannot read, append, or delegate', async () => {
  const { id, owner, other, request } = await fixture()
  expect((await request(`/${id}/entries`, { entries: [entry('hello', 'Private conversation')] })).status).toBe(200)
  expect((await request(`/${id}`, undefined, other.token)).status).toBe(404)
  expect((await request('/', { id }, other.token)).status).toBe(404)
  expect((await request(`/${id}/entries`, { entries: [entry('attack', 'No')] }, other.token)).status).toBe(404)
  expect(
    (await request(`/${id}/messages`, { clientId: randomUUID(), request: 'Do something' }, other.token)).status
  ).toBe(404)
  expect((await (await request('/', undefined, other.token)).json()).conversations).toEqual([])
  const manager = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: owner.id, context: {} })
  agentIds.push(manager.id)
  const token = await createTestAgentToken({ agentId: manager.id, squadId: null })
  expect((await request(`/${id}`, undefined, token.token)).status).toBe(200)
})
test('late transcription and tool completion retain their order; retries cannot rewrite final entries', async () => {
  const { id, request } = await fixture()
  const tool = {
    id: 'tool',
    role: 'tool',
    text: 'Checking',
    final: false,
    toolName: 'get_status',
    toolCallId: 'call-1',
  }
  expect(
    (
      await request(`/${id}/entries`, {
        entries: [entry('speech', '', false), tool, { ...entry('reply', 'Result'), role: 'assistant' }],
      })
    ).status
  ).toBe(200)
  const final = [entry('speech', 'What needs my attention?'), { ...tool, final: true, toolResult: '{"count":1}' }]
  expect(
    (await Promise.all([1, 2].map(() => request(`/${id}/entries`, { entries: final })))).map((r) => r.status)
  ).toEqual([200, 200])
  const data = await (await request(`/${id}`)).json()
  expect(data.entries.map((e: { id: string }) => e.id)).toEqual(['speech', 'tool', 'reply'])
  expect(data.entries[0].text).toBe('What needs my attention?')
  expect(data.conversation.title).toBe('What needs my attention?')
  expect((await request(`/${id}/entries`, { entries: [entry('speech', 'Changed text')] })).status).toBe(409)
  expect((await db.select().from(assistantEntries).where(eq(assistantEntries.conversationId, id))).length).toBe(3)
  expect((await db.select().from(agents).where(eq(agents.ownerUserId, data.conversation.ownerUserId))).length).toBe(0)
})
test('history pagination has no overlap and search treats wildcard characters literally', async () => {
  const { id, request } = await fixture()
  for (let batch = 0; batch < 3; batch++) {
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry(`e${batch * 40 + index}`, batch === 0 && index === 0 ? '100%_complete' : 'Message')
    )
    expect((await request(`/${id}/entries`, { entries })).status).toBe(200)
  }
  const recent = await (await request(`/${id}`)).json()
  expect(recent.entries.length).toBe(100)
  expect(recent.hasMore).toBe(true)
  const older = await (await request(`/${id}?before=${recent.before}`)).json()
  expect(older.entries.length).toBe(20)
  expect(older.hasMore).toBe(false)
  expect(new Set([...older.entries, ...recent.entries].map((e) => e.id)).size).toBe(120)
  expect((await (await request('/?q=%25_')).json()).conversations.map((c: { id: string }) => c.id)).toEqual([id])
  for (const query of ['limit=1.5', 'offset=Infinity', 'offset=-1', 'limit=1000'])
    expect((await request(`/?${query}`)).status).toBe(400)
  expect((await request(`/${id}?before=NaN`)).status).toBe(400)
})
test('ordinary inbox requests return durable receipts and serialize on one general helper', async () => {
  const { id, owner, request } = await fixture()
  const body = { clientId: randomUUID(), request: 'Investigate the current work queue', pagePath: '/squads/tau' }
  const first = await request(`/${id}/messages`, body)
  expect(first.status).toBe(200)
  const receipt = await first.json()
  agentIds.push(receipt.agentId)
  expect(receipt.kind).toBe('background')
  const second = await request(`/${id}/messages`, body)
  expect(second.status).toBe(200)
  expect((await second.json()).id).toBe(receipt.id)
  expect((await request(`/${id}/messages`, { ...body, request: 'Different request' })).status).toBe(409)
  const followup = await request(`/${id}/messages`, { ...body, clientId: randomUUID(), request: 'Also check errors' })
  expect(followup.status).toBe(200)
  expect((await followup.json()).agentId).toBe(receipt.agentId)
  const agent = await Agent.mustFind(receipt.agentId)
  expect(agent.ownerUserId).toBe(owner.id)
  const rows = await db
    .select()
    .from(inbox)
    .where(eq(inbox.senderId, assistantInboxRecipientId(id)))
  expect(rows).toHaveLength(2)
  expect(rows.every((row) => row.deliveryMode === 'steer')).toBe(true)
  expect(rows.filter((row) => row.metadata.pagePath)).toHaveLength(1)
  expect((await db.select().from(executions).where(eq(executions.agentId, agent.id))).length).toBe(1)
  const formatted = formatInboxMessages([await InboxMessage.mustFind(receipt.id)])
  expect(formatted).toContain(`--in-reply-to ${receipt.id}`)
  expect(formatted).toContain(assistantInboxRecipientId(id))
  expect(formatted).toContain('Ordinary chat output is not forwarded')
})

test('offline replies persist, one device receives, and lease expiry allows reconnect elsewhere', async () => {
  const { id, request, other } = await fixture()
  const receipt = await (await request(`/${id}/messages`, { clientId: randomUUID(), request: 'Investigate' })).json()
  agentIds.push(receipt.agentId)
  const reply = await InboxMessage.send({
    senderType: 'agent',
    senderId: receipt.agentId,
    recipientType: 'voice_assistant',
    recipientId: assistantInboxRecipientId(id),
    content: 'What project should I use?',
    metadata: { inReplyTo: receipt.id },
  })
  const consumerId = randomUUID(),
    second = randomUUID()
  expect((await request(`/${id}/inbox`, { consumerId }, other.token)).status).toBe(404)
  const first = await (await request(`/${id}/inbox`, { consumerId })).json()
  expect(first.acquired).toBe(true)
  // A question is progress, not completion: the delegated task stays pending.
  expect(first.pending).toBe(1)
  expect(first.messages.map((message: { messageId: string }) => message.messageId)).toEqual([reply.id])
  expect(first.messages[0]).toMatchObject({ taskId: receipt.taskId, requestId: receipt.id, sequence: 1 })
  expect((await (await request(`/${id}/inbox`, { consumerId: second })).json()).acquired).toBe(false)
  const response = { id: `inbox:${reply.id}`, role: 'tool', text: 'Task update', final: true }
  const ack = (consumer: string, extra: Record<string, unknown> = {}) =>
    request(`/${id}/inbox/ack`, {
      consumerId: consumer,
      messageIds: [reply.id],
      responseEntryId: response.id,
      ...extra,
    })
  expect((await ack(second)).status).toBe(409)
  await db
    .update(assistantConversations)
    .set({ inboxConsumerExpiresAt: new Date(0) })
    .where(eq(assistantConversations.id, id))
  expect((await (await request(`/${id}/inbox`, { consumerId: second })).json()).messages[0].content).toBe(reply.content)
  // The expired consumer cannot acknowledge, and neither can the current one without a saved final response.
  expect((await ack(consumerId)).status).toBe(409)
  expect((await ack(second)).status).toBe(409)
  expect((await request(`/${id}/entries`, { entries: [{ ...response, final: false }] })).status).toBe(200)
  expect((await ack(second)).status).toBe(409)
  expect((await request(`/${id}/entries`, { entries: [{ ...response, assistantUpdateIds: [reply.id] }] })).status).toBe(
    200
  )
  expect((await ack(second)).status).toBe(200)
  expect((await ack(second)).status).toBe(200)
  expect((await (await request(`/${id}/inbox`, { consumerId: second })).json()).messages).toEqual([])
  const [processed] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, reply.id))
  expect(processed.processedAt).not.toBeNull()
  expect(processed.seenAt).toBeNull()
  expect((await (await request('/activity')).json()).totals.unreadUpdates).toBe(1)
  expect((await request(`/${id}/inbox/release`, { consumerId: second })).status).toBe(200)
  expect((await (await request(`/${id}/inbox`, { consumerId })).json()).acquired).toBe(true)
})

test('only contacted agents can reply; inReplyTo stays local and cannot cross conversations', async () => {
  const { id, owner, other, request } = await fixture()
  const allowed = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: owner.id, context: {} })
  const foreign = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: other.id, context: {} })
  agentIds.push(allowed.id, foreign.id)
  expect(
    (await request(`/${id}/messages`, { agentId: foreign.id, request: 'Private', clientId: randomUUID() })).status
  ).toBe(404)
  const receipt = await (
    await request(`/${id}/messages`, { agentId: allowed.id, request: 'Question', clientId: randomUUID() })
  ).json()
  const input = {
    senderType: 'agent' as const,
    senderId: foreign.id,
    recipientType: 'voice_assistant' as const,
    recipientId: assistantInboxRecipientId(id),
    content: 'Fake result',
    metadata: { inReplyTo: receipt.id },
  }
  await expect(InboxMessage.send(input)).rejects.toThrow('recipient of its request')
  await expect(InboxMessage.send({ ...input, senderId: allowed.id, metadata: { inReplyTo: 'bad' } })).rejects.toThrow(
    'full inbox message UUID'
  )
  await expect(
    InboxMessage.send({ ...input, senderId: allowed.id, metadata: { inReplyTo: randomUUID() } })
  ).rejects.toThrow('recipient of its request')
  const token = await createTestAgentToken({ agentId: allowed.id, squadId: null })
  const response = await app.request('/api/inbox', {
    method: 'POST',
    headers: { ...authHeaders(token.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipientType: 'voice_assistant',
      recipientId: assistantInboxRecipientId(id),
      content: 'Which project?',
      inReplyTo: receipt.id,
    }),
  })
  expect(response.status).toBe(201)
  const reply = await response.json()
  expect(reply.metadata.inReplyTo).toBe(receipt.id)
  expect(
    (
      await request(`/${id}/messages`, {
        agentId: allowed.id,
        request: 'Tau',
        clientId: randomUUID(),
        inReplyTo: reply.id,
      })
    ).status
  ).toBe(200)
})

test('page editors scope tools to their conversation and reject stale, invalid, and closed proposals', async () => {
  const { createBlankWorkflow } = await import('@tau/shared')
  const { createPageEditorTools } = await import('../tools/page-editor')
  const f = await fixture()
  const role = await createTestRole({ prefix, permissions: ['workflows:create', 'agent-types:read'] })
  await assignRole({ userId: f.owner.id, roleId: role.id, scope: 'system' })
  const draft = { kind: 'workflow', target: {}, revision: 0, document: createBlankWorkflow(), selection: 'execute' }
  const update = (value: unknown, token = f.owner.token) =>
    app.request(`/api/assistant/${f.id}/editor`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
  expect((await update(draft, f.other.token)).status).toBe(403)
  expect((await update(draft)).status).toBe(200)
  expect((await f.request(`/${f.id}/editor`, undefined, f.other.token)).status).toBe(404)
  const manager = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: f.owner.id, context: {} })
  const stranger = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: f.owner.id, context: {} })
  agentIds.push(manager.id, stranger.id)
  await db.insert(assistantConversationAgents).values({ conversationId: f.id, squadId: null, agentId: manager.id })
  const tools = createPageEditorTools(manager.id, f.id)
  const denied = await createPageEditorTools(stranger.id, f.id)[0]!.execute(
    'read',
    {},
    new AbortController().signal,
    undefined,
    {} as any
  )
  expect(denied.details).toEqual({ error: true })
  const next = { ...draft.document, name: 'Reviewed proposal' }
  const args = { baseRevision: 0, summary: 'Rename the draft', documentJson: JSON.stringify(next) }
  const result = await tools[1]!.execute('propose', args, new AbortController().signal, undefined, {} as any)
  expect(result.details).toMatchObject({ status: 'queued', baseRevision: 0 })
  expect(result.details).not.toHaveProperty('document')
  const compact = await tools[0]!.execute('read', {}, new AbortController().signal, undefined, {} as any)
  expect(compact.details).toMatchObject({ revision: 0, document: draft.document })
  expect(compact.details).not.toHaveProperty('integrationOutputs')
  expect(compact.details).not.toHaveProperty('contract')
  // The page applies and acknowledges edits; another agent edit cannot replace an unconsumed one.
  expect((await (await f.request(`/${f.id}/editor`)).json()).document).toEqual(draft.document)
  expect((await f.request(`/${f.id}/editor/propose`, args)).status).toBe(409)
  const pending = await (await f.request(`/${f.id}/editor`)).json()
  // Selection-only updates must not discard an edit before the page receives it.
  expect((await update({ ...draft, selection: 'finish' })).status).toBe(200)
  expect((await (await f.request(`/${f.id}/editor`)).json()).proposal.id).toBe(pending.proposal.id)
  expect(
    (await update({ ...draft, revision: 1, document: next, acknowledgedProposalId: pending.proposal.id })).status
  ).toBe(200)
  expect((await (await f.request(`/${f.id}/editor`)).json()).proposal).toBeUndefined()
  // A valid no-op still needs acknowledgement before another edit can be sent.
  expect((await f.request(`/${f.id}/editor/propose`, { ...args, baseRevision: 1 })).status).toBe(200)
  const noop = await (await f.request(`/${f.id}/editor`)).json()
  expect(
    (await update({ ...draft, revision: 1, document: next, acknowledgedProposalId: noop.proposal.id })).status
  ).toBe(200)
  expect((await f.request(`/${f.id}/editor/propose`, args)).status).toBe(409)
  expect((await update(draft)).status).toBe(409)
  expect((await f.request(`/${f.id}/editor/propose`, { ...args, baseRevision: 1, documentJson: '{}' })).status).toBe(
    400
  )
  expect((await update({ ...draft, revision: 2, target: { presetId: 'solo' } })).status).not.toBe(200)
  expect(
    (await app.request(`/api/assistant/${f.id}/editor`, { method: 'DELETE', headers: authHeaders(f.owner.token) }))
      .status
  ).toBe(200)
  expect((await f.request(`/${f.id}/editor/propose`, { ...args, baseRevision: 1 })).status).toBe(404)
  expect((await update({ ...draft, revision: 2 })).status).toBe(409)
})

test('page editor validation prevents an agent proposal from accepting an unknown integration output', async () => {
  const { createBlankWorkflow } = await import('@tau/shared')
  const f = await fixture()
  const role = await createTestRole({ prefix, permissions: ['workflows:create'] })
  await assignRole({ userId: f.owner.id, roleId: role.id, scope: 'system' })
  const document = createBlankWorkflow()
  await app.request(`/api/assistant/${f.id}/editor`, {
    method: 'PUT',
    headers: { ...authHeaders(f.owner.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'workflow', target: {}, revision: 0, document }),
  })
  const response = await f.request(`/${f.id}/editor/propose`, {
    baseRevision: 0,
    summary: 'Invalid change',
    documentJson: JSON.stringify({
      ...document,
      subscriptions: [
        {
          id: 'unknown',
          source: { integration: 'unknown', output: 'missing', version: 1 },
          match: {},
          deliver: { to: 'active', whenInactive: 'retain' },
        },
      ],
    }),
  })
  expect(response.status).toBe(400)
})

test('editor operations and history actions share revision checks and atomic proposal delivery', async () => {
  const { createBlankWorkflow } = await import('@tau/shared')
  const f = await fixture()
  const role = await createTestRole({ prefix, permissions: ['workflows:create'] })
  await assignRole({ userId: f.owner.id, roleId: role.id, scope: 'system' })
  const draft = {
    kind: 'workflow',
    target: {},
    preset: { id: 'research', description: 'Original description' },
    revision: 0,
    document: createBlankWorkflow(),
    history: { canUndo: false, canRedo: false },
  }
  const sync = (value: unknown) =>
    app.request(`/api/assistant/${f.id}/editor`, {
      method: 'PUT',
      headers: { ...authHeaders(f.owner.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
  expect((await sync(draft)).status).toBe(200)
  expect(
    (await f.request(`/${f.id}/editor/propose`, { baseRevision: 0, summary: 'Undo', historyAction: 'undo' })).status
  ).toBe(409)
  const invalid = await f.request(`/${f.id}/editor/propose`, {
    baseRevision: 0,
    summary: 'Invalid connection',
    preset: { description: 'Rejected metadata' },
    operations: [{ op: 'set-outcome', id: 'execute', outcome: 'completed', transition: { next: 'missing' } }],
  })
  expect(invalid.status).toBe(400)
  const rejection = await invalid.text()
  expect(rejection).toContain('no changes applied')
  expect(rejection).toContain('revision 0')
  expect(rejection).toContain('resubmit the complete edit batch')
  const unchanged = await (await f.request(`/${f.id}/editor`)).json()
  expect(unchanged.proposal).toBeUndefined()
  expect(unchanged.revision).toBe(0)
  expect(unchanged.document).toEqual(draft.document)
  expect(unchanged.preset).toEqual(draft.preset)
  const edited = await f.request(`/${f.id}/editor/propose`, {
    baseRevision: 0,
    summary: 'Cite sources',
    preset: { description: 'Use for evidence-based research.' },
    operations: [{ op: 'update-step', id: 'execute', changes: { instructions: 'Cite all sources.' } }],
  })
  expect(edited.status).toBe(200)
  const proposal = (await edited.json()).proposal
  expect(proposal.preset).toEqual({ id: 'research', description: 'Use for evidence-based research.' })
  expect((await sync({ ...draft, preset: proposal.preset })).status).toBe(409)
  expect(proposal.document.steps[0].instructions).toBe('Cite all sources.')
  expect(proposal.document.limits).toEqual(draft.document.limits)
  expect(
    (
      await sync({
        ...draft,
        revision: 1,
        document: proposal.document,
        preset: proposal.preset,
        history: { canUndo: true, canRedo: false },
        acknowledgedProposalId: proposal.id,
      })
    ).status
  ).toBe(200)
  const undo = { baseRevision: 1, summary: 'Undo the edit', historyAction: 'undo' }
  expect((await f.request(`/${f.id}/editor/propose`, { ...undo, baseRevision: 0 })).status).toBe(409)
  expect(
    (await f.request(`/${f.id}/editor/propose`, { ...undo, operations: [{ op: 'set-name', name: 'Ambiguous' }] }))
      .status
  ).toBe(400)
  const undoResponse = await f.request(`/${f.id}/editor/propose`, undo)
  expect(undoResponse.status).toBe(200)
  const undoProposal = (await undoResponse.json()).proposal
  expect(undoProposal.historyAction).toBe('undo')
  expect((await f.request(`/${f.id}/editor/propose`, undo)).status).toBe(409)
  expect(
    (
      await sync({
        ...draft,
        revision: 2,
        history: { canUndo: false, canRedo: true },
        acknowledgedProposalId: undoProposal.id,
      })
    ).status
  ).toBe(200)
  expect(
    (await f.request(`/${f.id}/editor/propose`, { baseRevision: 2, summary: 'Redo', historyAction: 'redo' })).status
  ).toBe(200)
})

async function squadFixture(owner: { id: string }, role: { id: string }) {
  const squad = await Squad.create({ name: `${prefix}-squad-${randomUUID().slice(0, 8)}`, purpose: 'test' })
  squadIds.push(squad.id)
  await assignRole({ userId: owner.id, roleId: role.id, scope: 'squad', squadId: squad.id })
  return squad
}

test('squad delegations create one owned consultant per squad, label it, and steer by default', async () => {
  const { id, owner, request } = await fixture()
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  const squad = await squadFixture(owner, role)
  const body = {
    clientId: randomUUID(),
    request: 'List enabled schedules',
    squadId: squad.id,
    label: 'Check enabled schedules',
  }
  const first = await request(`/${id}/messages`, body)
  expect(first.status).toBe(200)
  const receipt = await first.json()
  agentIds.push(receipt.agentId)
  expect(receipt).toMatchObject({ kind: 'squad', squadId: squad.id })
  const consultant = await Agent.mustFind(receipt.agentId)
  expect(consultant.agentTypeId).toBe('consultant')
  expect(consultant.squadId).toBe(squad.id)
  expect(consultant.metadata?.name).toBe('Assistant task')
  expect(consultant.metadata?.purpose).toBe('Assistant task: Check enabled schedules')
  const second = await request(`/${id}/messages`, { ...body, clientId: randomUUID(), label: 'Pause the deploy stream' })
  expect((await second.json()).agentId).toBe(receipt.agentId)
  expect((await Agent.mustFind(receipt.agentId)).metadata?.purpose).toBe('Assistant task: Pause the deploy stream')
  // Reusing the first request's clientId with different content conflicts (409); the relabel
  // only applies after a request is accepted, so a rejected retry must not rewrite the purpose.
  const conflict = await request(`/${id}/messages`, {
    ...body,
    request: 'Different request',
    label: 'Reroute the deploy pipeline',
  })
  expect(conflict.status).toBe(409)
  expect((await Agent.mustFind(receipt.agentId)).metadata?.purpose).toBe('Assistant task: Pause the deploy stream')
  const rows = await db.select().from(inbox).where(eq(inbox.recipientId, receipt.agentId))
  expect(rows.map((row) => row.deliveryMode)).toEqual(['steer', 'steer'])
  const general = await request(`/${id}/messages`, {
    clientId: randomUUID(),
    request: 'General task',
    label: 'General task',
  })
  const generalReceipt = await general.json()
  agentIds.push(generalReceipt.agentId)
  expect(generalReceipt.kind).toBe('background')
  expect(generalReceipt.agentId).not.toBe(receipt.agentId)
  expect((await Agent.mustFind(generalReceipt.agentId)).metadata?.purpose).toBe('Assistant task: General task')
  const owned = await db
    .select()
    .from(assistantConversationAgents)
    .where(eq(assistantConversationAgents.conversationId, id))
  expect(owned.map((row) => row.squadId).sort()).toEqual([null, squad.id].sort())
})

test('squad delegations reject mixed targets and unknown or inactive squads, and own one consultant per conversation', async () => {
  const { id, owner, other, request } = await fixture()
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  const squad = await squadFixture(owner, role)
  const base = { clientId: randomUUID(), request: 'Task', label: 'Task' }
  expect((await request(`/${id}/messages`, { ...base, squadId: squad.id, agentId: randomUUID() })).status).toBe(400)
  expect((await request(`/${id}/messages`, { ...base, squadId: randomUUID() })).status).toBe(404)
  // An existing but inactive squad must be rejected too, and must not leave behind an owned-agent row.
  const archived = await Squad.create({ name: `${prefix}-squad-${randomUUID().slice(0, 8)}`, purpose: 'test' })
  squadIds.push(archived.id)
  await db.update(squads).set({ status: 'archived' }).where(eq(squads.id, archived.id))
  expect((await request(`/${id}/messages`, { ...base, clientId: randomUUID(), squadId: archived.id })).status).toBe(404)
  expect(
    await db.select().from(assistantConversationAgents).where(eq(assistantConversationAgents.conversationId, id))
  ).toEqual([])
  // Ownership is scoped per conversation, not per squad: two different owners delegating to the
  // same active squad from their own conversations must each get their own owned consultant.
  const otherConversation = randomUUID()
  conversationIds.push(otherConversation)
  expect((await request('/', { id: otherConversation }, other.token)).status).toBe(200)
  // `other` has no squad-scoped role here; fixture()'s system-scope chat:send role already
  // satisfies hasPermission(identity, 'chat:send', squad.id), same as the rest of this route.
  const delegated = await request(
    `/${otherConversation}/messages`,
    { ...base, clientId: randomUUID(), squadId: squad.id },
    other.token
  )
  expect(delegated.status).toBe(200)
  const delegatedReceipt = await delegated.json()
  agentIds.push(delegatedReceipt.agentId)
  const ownerDelegation = await request(`/${id}/messages`, { ...base, clientId: randomUUID(), squadId: squad.id })
  expect(ownerDelegation.status).toBe(200)
  const ownerReceipt = await ownerDelegation.json()
  agentIds.push(ownerReceipt.agentId)
  expect(delegatedReceipt.agentId).not.toBe(ownerReceipt.agentId)
})

test('a reply without an explicit target continues the squad task that sent it, subject to squad access', async () => {
  const { id, owner, request } = await fixture()
  const role = await createTestRole({ prefix, permissions: ['chat:send'] })
  const squad = await squadFixture(owner, role)
  const delegated = await request(`/${id}/messages`, {
    clientId: randomUUID(),
    request: 'Check the deploy stream',
    squadId: squad.id,
    label: 'Check the deploy stream',
  })
  expect(delegated.status).toBe(200)
  const receipt = await delegated.json()
  agentIds.push(receipt.agentId)
  expect(receipt).toMatchObject({ kind: 'squad', squadId: squad.id })

  const token = await createTestAgentToken({ agentId: receipt.agentId, squadId: squad.id })
  const replied = await app.request('/api/inbox', {
    method: 'POST',
    headers: { ...authHeaders(token.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipientType: 'voice_assistant',
      recipientId: assistantInboxRecipientId(id),
      content: 'Which environment?',
      inReplyTo: receipt.id,
    }),
  })
  expect(replied.status).toBe(201)
  const reply = await replied.json()

  // No squadId here: the reply itself identifies the owned consultant that asked the question.
  const followUp = await request(`/${id}/messages`, {
    clientId: randomUUID(),
    request: 'Production',
    inReplyTo: reply.id,
  })
  expect(followUp.status).toBe(200)
  expect(await followUp.json()).toMatchObject({ agentId: receipt.agentId, kind: 'squad', squadId: squad.id })

  // A squad reached through a reply is re-checked like an explicit one: archiving it closes the
  // reply path too, rather than letting inReplyTo bypass the squad gate.
  await db.update(squads).set({ status: 'archived' }).where(eq(squads.id, squad.id))
  const afterArchive = await request(`/${id}/messages`, {
    clientId: randomUUID(),
    request: 'Still production',
    inReplyTo: reply.id,
  })
  expect(afterArchive.status).toBe(404)
})

for (const scoped of [false, true]) {
  test(`replies target dormant helpers and reject terminated helpers without replacing them (squad=${scoped})`, async () => {
    const { id, owner, request } = await fixture()
    const role = await createTestRole({ prefix, permissions: ['chat:send'] })
    const squad = scoped ? await squadFixture(owner, role) : null
    const delegated = await request(`/${id}/messages`, {
      clientId: randomUUID(),
      request: 'Check deployment',
      ...(squad ? { squadId: squad.id } : {}),
    })
    expect(delegated.status).toBe(200)
    const receipt = await delegated.json()
    agentIds.push(receipt.agentId)
    const token = await createTestAgentToken({ agentId: receipt.agentId, squadId: squad?.id ?? null })
    const replied = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'voice_assistant',
        recipientId: assistantInboxRecipientId(id),
        content: 'Which environment?',
        inReplyTo: receipt.id,
      }),
    })
    expect(replied.status).toBe(201)
    const reply = await replied.json()
    // Simulate a dormant recipient; the route must preserve its identity and enqueue a wake-eligible reply.
    await db.delete(executions).where(eq(executions.agentId, receipt.agentId))
    await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, receipt.agentId))
    const followUp = await request(`/${id}/messages`, {
      clientId: randomUUID(),
      request: 'Staging',
      inReplyTo: reply.id,
    })
    expect(followUp.status).toBe(200)
    expect(await followUp.clone().json()).toMatchObject({ agentId: receipt.agentId })
    const replyReceipt = await InboxMessage.mustFind((await followUp.json()).id)
    expect(replyReceipt.recipientId).toBe(receipt.agentId)
    expect(replyReceipt.metadata.wakeEligible).toBe(true)
    await db.delete(executions).where(eq(executions.agentId, receipt.agentId))
    await db
      .update(agents)
      .set({ status: 'terminated', terminatedAt: new Date() })
      .where(eq(agents.id, receipt.agentId))
    const ended = await request(`/${id}/messages`, {
      clientId: randomUUID(),
      request: 'Continue',
      inReplyTo: reply.id,
    })
    expect(ended.status).toBe(409)
    expect((await ended.json()).error).toContain('Start a new task without inReplyTo')
    expect(
      await db
        .select({ agentId: assistantConversationAgents.agentId })
        .from(assistantConversationAgents)
        .where(eq(assistantConversationAgents.conversationId, id))
    ).toEqual([{ agentId: receipt.agentId }])
    const restarted = await request(`/${id}/messages`, {
      clientId: randomUUID(),
      request: 'New task',
      ...(squad ? { squadId: squad.id } : {}),
    })
    expect(restarted.status).toBe(200)
    const fresh = await restarted.json()
    agentIds.push(fresh.agentId)
    expect(fresh.agentId).not.toBe(receipt.agentId)
    const oldReply = await request(`/${id}/messages`, {
      clientId: randomUUID(),
      request: 'Continue old task',
      inReplyTo: reply.id,
    })
    expect(oldReply.status).toBe(409)
    expect(
      await db
        .select({ agentId: assistantConversationAgents.agentId })
        .from(assistantConversationAgents)
        .where(eq(assistantConversationAgents.conversationId, id))
    ).toEqual([{ agentId: fresh.agentId }])
  })
}

test('invalid replies do not allocate a helper', async () => {
  const { id, request } = await fixture()
  const response = await request(`/${id}/messages`, {
    clientId: randomUUID(),
    request: 'Answer',
    inReplyTo: randomUUID(),
  })
  expect(response.status).toBe(404)
  expect(
    await db.select().from(assistantConversationAgents).where(eq(assistantConversationAgents.conversationId, id))
  ).toEqual([])
})

type ReportedStatus = 'working' | 'waiting' | 'needs-input' | 'completed' | 'failed' | 'cancelled'
async function activityFixture() {
  const f = await fixture()
  const agent = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: f.owner.id, context: {} })
  agentIds.push(agent.id)
  const start = async (text = 'Compare the options', extra: Record<string, unknown> = {}) => {
    const response = await f.request(`/${f.id}/messages`, {
      clientId: randomUUID(),
      request: text,
      agentId: agent.id,
      label: 'Compare options',
      ...extra,
    })
    expect(response.status).toBe(200)
    return response.json() as Promise<{ id: string; taskId: string; agentId: string }>
  }
  const update = (requestId: string, content: string, status?: ReportedStatus) =>
    InboxMessage.send({
      recipientType: 'voice_assistant',
      recipientId: assistantInboxRecipientId(f.id),
      senderType: 'agent',
      senderId: agent.id,
      content,
      metadata: { inReplyTo: requestId },
      assistantTaskStatus: status,
    })
  const task = async (taskId: string) => {
    const [row] = await db.select().from(assistantTasks).where(eq(assistantTasks.id, taskId))
    return row
  }
  return { ...f, agent, start, update, task }
}

test('first progress reply preserves working task state', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  expect(receipt.taskId).toBe(receipt.id)
  await f.update(receipt.id, 'Research has started.')
  const task = await f.task(receipt.taskId)
  expect(task.status).toBe('working')
  expect(task.label).toBe('Compare options')
  expect(task.kind).toBe('agent')
  expect(task.agentId).toBe(f.agent.id)
})

test('multiple tasks can share one helper without sharing lifecycle', async () => {
  const f = await activityFixture()
  const a = await f.start('Compare options')
  const b = await f.start('Check deployment settings')
  expect(a.taskId).not.toBe(b.taskId)
  await f.update(a.id, 'Comparison complete.', 'completed')
  expect((await f.task(a.taskId)).status).toBe('completed')
  expect((await f.task(b.taskId)).status).toBe('working')
})

test('updates exist durably without any browser consumer', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  const message = await f.update(receipt.id, 'Ready for your decision.', 'needs-input')
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, message.id))
  expect(update.taskId).toBe(receipt.taskId)
  expect(update.requestId).toBe(receipt.id)
  expect(update.reportedStatus).toBe('needs-input')
  expect(update.processedAt).toBeNull()
  expect(update.seenAt).toBeNull()
  expect(update.sequence).toBe(1)
  expect((await f.task(receipt.taskId)).status).toBe('needs-input')
  const [conversation] = await db.select().from(assistantConversations).where(eq(assistantConversations.id, f.id))
  expect(conversation.nextUpdateSequence).toBe(1)
  expect(conversation.inboxConsumerId).toBeNull()
})

test('idempotent request retries and update retries never duplicate task state', async () => {
  const f = await activityFixture()
  const body = { clientId: randomUUID(), request: 'Compare the options', agentId: f.agent.id, label: 'Compare' }
  const first = await (await f.request(`/${f.id}/messages`, body)).json()
  const second = await (await f.request(`/${f.id}/messages`, body)).json()
  expect(second).toMatchObject({ id: first.id, taskId: first.taskId })
  expect(await db.select().from(assistantTasks).where(eq(assistantTasks.conversationId, f.id))).toHaveLength(1)
  const input = {
    recipientType: 'voice_assistant' as const,
    recipientId: assistantInboxRecipientId(f.id),
    senderType: 'agent' as const,
    senderId: f.agent.id,
    content: 'Done.',
    metadata: { inReplyTo: first.id },
    assistantTaskStatus: 'completed' as const,
  }
  const key = `${assistantInboxRecipientId(f.id)}:${randomUUID()}`
  const one = await InboxMessage.sendOnce(input, key)
  const two = await InboxMessage.sendOnce(input, key)
  expect(one.created).toBe(true)
  expect(two.created).toBe(false)
  expect(two.message.id).toBe(one.message.id)
  expect(await db.select().from(assistantUpdates).where(eq(assistantUpdates.conversationId, f.id))).toHaveLength(1)
  const [conversation] = await db.select().from(assistantConversations).where(eq(assistantConversations.id, f.id))
  expect(conversation.nextUpdateSequence).toBe(1)
})

test('a user answer stays on its task and stale reports cannot finish the new request', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  const question = await f.update(receipt.id, 'Which region?', 'needs-input')
  expect((await f.task(receipt.taskId)).status).toBe('needs-input')
  const answer = await (
    await f.request(`/${f.id}/messages`, {
      clientId: randomUUID(),
      request: 'us-east',
      agentId: f.agent.id,
      inReplyTo: question.id,
    })
  ).json()
  expect(answer.taskId).toBe(receipt.taskId)
  expect(answer.id).not.toBe(receipt.id)
  let task = await f.task(receipt.taskId)
  expect(task.currentRequestId).toBe(answer.id)
  expect(task.status).toBe('working')
  // A late report against the superseded request stays visible but changes nothing.
  const stale = await f.update(receipt.id, 'Old request complete.', 'completed')
  task = await f.task(receipt.taskId)
  expect(task.status).toBe('working')
  const [staleUpdate] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, stale.id))
  expect(staleUpdate.taskId).toBe(receipt.taskId)
  expect(staleUpdate.sequence).toBe(2)
  await f.update(answer.id, 'Deployed to us-east.', 'completed')
  expect((await f.task(receipt.taskId)).status).toBe('completed')
  // Terminal requests do not reopen on late progress; a new follow-up does.
  await f.update(answer.id, 'Still working actually.', 'working')
  expect((await f.task(receipt.taskId)).status).toBe('completed')
  const reopened = await (
    await f.request(`/${f.id}/messages`, {
      clientId: randomUUID(),
      request: 'Also deploy to eu-west',
      agentId: f.agent.id,
      inReplyTo: stale.id,
    })
  ).json()
  expect(reopened.taskId).toBe(receipt.taskId)
  task = await f.task(receipt.taskId)
  expect(task).toMatchObject({ currentRequestId: reopened.id, status: 'working' })
})

test('an independent request creates another task even for the same helper', async () => {
  const f = await activityFixture()
  const first = await f.start('Compare options')
  await f.update(first.id, 'Comparison complete.', 'completed')
  const second = await f.start('Check deployment settings')
  expect(second.taskId).toBe(second.id)
  expect(second.taskId).not.toBe(first.taskId)
  const rows = await db.select().from(assistantTasks).where(eq(assistantTasks.conversationId, f.id))
  expect(rows.map((row) => row.status).sort()).toEqual(['completed', 'working'])
})

test('a failed projection rolls back the inbox insertion', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  setBeforeRecipientLifecycleLockHookForTest(async () => {
    // Validation already passed; removing the conversation makes the in-transaction projection fail.
    await db.delete(assistantConversations).where(eq(assistantConversations.id, f.id))
  })
  try {
    await expect(f.update(receipt.id, 'Orphaned update', 'completed')).rejects.toThrow(
      'Assistant conversation not found'
    )
  } finally {
    setBeforeRecipientLifecycleLockHookForTest(undefined)
  }
  expect(await db.select().from(inbox).where(eq(inbox.content, 'Orphaned update'))).toEqual([])
})

test('a terminated helper leaves persisted task status alone but marks it unavailable', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  await db.delete(executions).where(eq(executions.agentId, f.agent.id))
  await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, f.agent.id))
  expect((await f.task(receipt.taskId)).status).toBe('working')
  const mailbox = await (await f.request(`/${f.id}/inbox`, { consumerId: randomUUID() })).json()
  expect(mailbox).toMatchObject({ acquired: true, pending: 1, unavailable: true })
})

test('generic metadata cannot smuggle task status or task identity', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  for (const smuggled of [{ assistantTaskStatus: 'completed' }, { assistantTaskId: randomUUID() }])
    await expect(
      InboxMessage.send({
        recipientType: 'voice_assistant',
        recipientId: assistantInboxRecipientId(f.id),
        senderType: 'agent',
        senderId: f.agent.id,
        content: 'Sneaky',
        metadata: { inReplyTo: receipt.id, ...smuggled },
      })
    ).rejects.toThrow('server-owned')
  expect((await f.task(receipt.taskId)).status).toBe('working')
  // Ordinary replies without the field stay supported and leave lifecycle state unchanged.
  const plain = await f.update(receipt.id, 'Just an update')
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, plain.id))
  expect(update.reportedStatus).toBeNull()
  expect((await f.task(receipt.taskId)).status).toBe('working')
})

test('activity is available without acquiring a realtime lease', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  await f.update(receipt.id, 'The task is complete.', 'completed')
  const response = await f.request('/activity')
  expect(response.status).toBe(200)
  const activity = await response.json()
  expect(activity.totals).toEqual({
    unreadConversations: 1,
    unreadUpdates: 1,
    workingTasks: 0,
    waitingTasks: 0,
    needsInputTasks: 0,
    unavailableTasks: 0,
  })
  expect(activity.hasMore).toBe(false)
  expect(activity.conversations).toHaveLength(1)
  expect(activity.conversations[0]).toMatchObject({
    id: f.id,
    unreadUpdates: 1,
    latestUpdateSequence: 1,
    latestUpdate: { preview: 'The task is complete.' },
  })
  const [conversation] = await db.select().from(assistantConversations).where(eq(assistantConversations.id, f.id))
  expect(conversation.inboxConsumerId).toBeNull()
  const detail = await (await f.request(`/${f.id}/activity`)).json()
  expect(detail.tasks).toHaveLength(1)
  expect(detail.tasks[0]).toMatchObject({ id: receipt.taskId, status: 'completed', unavailable: false })
  expect(detail.updates).toHaveLength(1)
  expect(detail.updates[0]).toMatchObject({
    taskId: receipt.taskId,
    sequence: 1,
    reportedStatus: 'completed',
    content: 'The task is complete.',
    processedAt: null,
    seenAt: null,
  })
  expect(detail.hasMore).toBe(false)
  // Reads never process or acknowledge anything.
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.conversationId, f.id))
  expect(update.processedAt).toBeNull()
  expect(update.seenAt).toBeNull()
})

test('viewing an update does not mark it processed', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  const message = await f.update(receipt.id, 'Please choose an option.', 'needs-input')
  expect((await f.request(`/${f.id}/updates/seen`, { messageIds: [message.id] })).status).toBe(200)
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, message.id))
  expect(update.seenAt).not.toBeNull()
  expect(update.processedAt).toBeNull()
  // Acknowledging already-seen IDs is harmless and keeps the first timestamp.
  expect((await f.request(`/${f.id}/updates/seen`, { messageIds: [message.id] })).status).toBe(200)
  const [again] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, message.id))
  expect(again.seenAt?.getTime()).toBe(update.seenAt!.getTime())
  const activity = await (await f.request('/activity')).json()
  expect(activity.totals).toMatchObject({ unreadConversations: 0, unreadUpdates: 0, needsInputTasks: 1 })
  expect(activity.conversations.map((row: { id: string }) => row.id)).toEqual([f.id])
})

test('another owner cannot read or acknowledge activity', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  const message = await f.update(receipt.id, 'Private result.', 'completed')
  expect((await f.request(`/${f.id}/activity`, undefined, f.other.token)).status).toBe(404)
  expect((await f.request(`/${f.id}/updates/seen`, { messageIds: [message.id] }, f.other.token)).status).toBe(404)
  expect((await f.request(`/${f.id}/updates/seen-through`, { sequence: 1 }, f.other.token)).status).toBe(404)
  const foreign = await (await f.request('/activity', undefined, f.other.token)).json()
  expect(foreign.conversations).toEqual([])
  expect(foreign.totals.unreadUpdates).toBe(0)
  // A batch mixing in another conversation's update is rejected whole.
  const otherId = randomUUID()
  conversationIds.push(otherId)
  expect((await f.request('/', { id: otherId }, f.other.token)).status).toBe(200)
  expect((await f.request(`/${otherId}/updates/seen`, { messageIds: [message.id] }, f.other.token)).status).toBe(400)
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, message.id))
  expect(update.seenAt).toBeNull()
  for (const bad of [{ messageIds: [] }, { messageIds: ['nope'] }, { sequence: -1 }, {}])
    expect((await f.request(`/${f.id}/updates/seen`, bad)).status).toBe(400)
  expect((await f.request(`/${f.id}/updates/seen-through`, { sequence: 1.5 })).status).toBe(400)
})

test('marking updates read acknowledges only the displayed snapshot', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  await f.update(receipt.id, 'First')
  await f.update(receipt.id, 'Second')
  const snapshot = await (await f.request(`/${f.id}/activity`)).json()
  expect(snapshot.conversation.latestUpdateSequence).toBe(2)
  const third = await f.update(receipt.id, 'Third')
  expect(
    (await f.request(`/${f.id}/updates/seen-through`, { sequence: snapshot.conversation.latestUpdateSequence })).status
  ).toBe(200)
  const rows = await db.select().from(assistantUpdates).where(eq(assistantUpdates.conversationId, f.id))
  expect(rows.filter((row) => row.seenAt === null).map((row) => row.messageId)).toEqual([third.id])
  expect(rows.every((row) => row.processedAt === null)).toBe(true)
  const activity = await (await f.request('/activity')).json()
  expect(activity.totals).toMatchObject({ unreadConversations: 1, unreadUpdates: 1, workingTasks: 1 })
})

test('activity totals stay global under pagination and order deterministically', async () => {
  const f = await activityFixture()
  const second = randomUUID(),
    third = randomUUID()
  conversationIds.push(second, third)
  for (const id of [second, third]) expect((await f.request('/', { id })).status).toBe(200)
  const a = await f.start('Task A')
  await f.update(a.id, 'Progress on A')
  const receipts = await Promise.all(
    [second, third].map(async (id) => {
      const response = await f.request(`/${id}/messages`, {
        clientId: randomUUID(),
        request: `Task in ${id}`,
        agentId: f.agent.id,
      })
      expect(response.status).toBe(200)
      return { id, receipt: (await response.json()) as { id: string } }
    })
  )
  const question = receipts.find((row) => row.id === third)!
  await InboxMessage.send({
    recipientType: 'voice_assistant',
    recipientId: assistantInboxRecipientId(third),
    senderType: 'agent',
    senderId: f.agent.id,
    content: 'Need a decision',
    metadata: { inReplyTo: question.receipt.id },
    assistantTaskStatus: 'needs-input',
  })
  // Equal timestamps for the two updated conversations keep the ID tie-breaker meaningful.
  const pinned = new Date('2026-09-15T00:00:00.000Z')
  await db
    .update(assistantConversations)
    .set({ updatedAt: pinned })
    .where(inArray(assistantConversations.id, [f.id, second, third]))
  const page = await (await f.request('/activity?limit=1')).json()
  expect(page.totals).toMatchObject({ unreadConversations: 2, unreadUpdates: 2, workingTasks: 2, needsInputTasks: 1 })
  expect(page.conversations).toHaveLength(1)
  expect(page.conversations[0].id).toBe(third)
  expect(page.hasMore).toBe(true)
  const rest = await (await f.request('/activity?limit=1&offset=1')).json()
  expect(rest.conversations[0].id).toBe(f.id)
  const last = await (await f.request('/activity?limit=1&offset=2')).json()
  expect(last.conversations[0].id).toBe(second)
  expect(last.hasMore).toBe(false)
  expect(last.totals).toEqual(page.totals)
  // Finished tasks with no unread updates fall out of the list, and pagination still reads the same order.
  const all = await (await f.request('/activity')).json()
  expect(all.conversations.map((row: { id: string }) => row.id)).toEqual([third, f.id, second])
})

async function agentSend(agentId: string, squadId: string | null, body: Record<string, unknown>) {
  const token = await createTestAgentToken({ agentId, squadId })
  return app.request('/api/inbox', {
    method: 'POST',
    headers: { ...authHeaders(token.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

for (const status of ['done', 'unknown', 'running', '']) {
  test(`rejects unsupported reported status ${JSON.stringify(status)}`, async () => {
    const f = await activityFixture()
    const receipt = await f.start()
    const response = await agentSend(f.agent.id, null, {
      recipientType: 'voice_assistant',
      recipientId: assistantInboxRecipientId(f.id),
      inReplyTo: receipt.id,
      content: 'Status update',
      assistantTaskStatus: status,
    })
    expect(response.status).toBe(400)
    expect((await f.task(receipt.taskId)).status).toBe('working')
    expect(await db.select().from(assistantUpdates).where(eq(assistantUpdates.conversationId, f.id))).toEqual([])
  })
}

test('reported status is accepted only from the contacted agent on its own request over HTTP', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  const stranger = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: f.owner.id, context: {} })
  agentIds.push(stranger.id)
  const mailbox = assistantInboxRecipientId(f.id)
  // Another agent cannot report on this request.
  expect(
    (
      await agentSend(stranger.id, null, {
        recipientType: 'voice_assistant',
        recipientId: mailbox,
        inReplyTo: receipt.id,
        content: 'Fake completion',
        assistantTaskStatus: 'completed',
      })
    ).status
  ).toBe(400)
  // The contacted agent cannot report through another conversation's mailbox.
  const otherId = randomUUID()
  conversationIds.push(otherId)
  expect((await f.request('/', { id: otherId }, f.other.token)).status).toBe(200)
  expect(
    (
      await agentSend(f.agent.id, null, {
        recipientType: 'voice_assistant',
        recipientId: assistantInboxRecipientId(otherId),
        inReplyTo: receipt.id,
        content: 'Wrong mailbox',
        assistantTaskStatus: 'completed',
      })
    ).status
  ).toBe(400)
  // The flag is rejected for unrelated recipients rather than silently ignored.
  expect(
    (
      await agentSend(f.agent.id, null, {
        recipientType: 'user',
        recipientId: f.owner.id,
        content: 'Not an Assistant reply',
        assistantTaskStatus: 'completed',
      })
    ).status
  ).toBe(400)
  // Metadata smuggling is rejected at the HTTP boundary.
  expect(
    (
      await agentSend(f.agent.id, null, {
        recipientType: 'voice_assistant',
        recipientId: mailbox,
        inReplyTo: receipt.id,
        content: 'Smuggled',
        metadata: { assistantTaskStatus: 'completed' },
      })
    ).status
  ).toBe(400)
  expect((await f.task(receipt.taskId)).status).toBe('working')
  // The real delegate's report lands and is persisted under server-controlled metadata.
  const accepted = await agentSend(f.agent.id, null, {
    recipientType: 'voice_assistant',
    recipientId: mailbox,
    inReplyTo: receipt.id,
    content: 'Finished',
    assistantTaskStatus: 'completed',
  })
  expect(accepted.status).toBe(201)
  const reply = await accepted.json()
  expect(reply.metadata.assistantTaskStatus).toBe('completed')
  expect((await f.task(receipt.taskId)).status).toBe('completed')
  const formatted = formatInboxMessages([await InboxMessage.mustFind(receipt.id)])
  expect(formatted).toContain('--assistant-task-status')
  expect(formatted).toContain(`--in-reply-to ${receipt.id}`)
})

test('mailbox acknowledgment requires a saved final response covering every update in this conversation', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  const first = await f.update(receipt.id, 'First result')
  const consumerId = randomUUID()
  expect((await (await f.request(`/${f.id}/inbox`, { consumerId })).json()).acquired).toBe(true)
  const ack = (body: Record<string, unknown>) =>
    f.request(`/${f.id}/inbox/ack`, { consumerId, messageIds: [first.id], responseEntryId: 'inbox:batch', ...body })
  // Missing saved response.
  expect((await ack({})).status).toBe(409)
  // A response saved in another conversation does not count.
  const otherId = randomUUID()
  conversationIds.push(otherId)
  expect((await f.request('/', { id: otherId })).status).toBe(200)
  const entry = { id: 'inbox:batch', role: 'tool', text: 'Task update', final: true, assistantUpdateIds: [first.id] }
  expect((await f.request(`/${otherId}/entries`, { entries: [entry] })).status).toBe(200)
  expect((await ack({})).status).toBe(409)
  // An update that arrived during response generation is not covered by the saved response.
  const late = await f.update(receipt.id, 'Late result')
  expect((await f.request(`/${f.id}/entries`, { entries: [entry] })).status).toBe(200)
  expect((await ack({ messageIds: [first.id, late.id] })).status).toBe(409)
  // Another conversation's update cannot be acknowledged here even alongside a valid one.
  expect((await ack({ messageIds: [first.id, randomUUID()] })).status).toBe(409)
  expect((await ack({})).status).toBe(200)
  const rows = await db.select().from(assistantUpdates).where(eq(assistantUpdates.conversationId, f.id))
  expect(rows.find((row) => row.messageId === first.id)?.processedAt).not.toBeNull()
  expect(rows.find((row) => row.messageId === late.id)?.processedAt).toBeNull()
  expect(rows.every((row) => row.seenAt === null)).toBe(true)
  // Replaying a valid acknowledgment is harmless; an expired lease refuses.
  expect((await ack({})).status).toBe(200)
  await db
    .update(assistantConversations)
    .set({ inboxConsumerExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(assistantConversations.id, f.id))
  expect((await ack({})).status).toBe(409)
  for (const bad of [{ messageIds: [] }, { responseEntryId: '' }, { messageIds: ['nope'] }])
    expect((await ack(bad)).status).toBe(400)
})

test('the delegated agent can report task status directly without tracking request IDs', async () => {
  const f = await activityFixture()
  const receipt = await f.start()
  const token = await createTestAgentToken({ agentId: f.agent.id, squadId: null })
  const call = (path: string, body?: unknown, auth = token.token) =>
    app.request(`/api/assistant-tasks${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...authHeaders(auth), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const shown = await call(`/${receipt.taskId}`)
  expect(shown.status).toBe(200)
  expect(await shown.json()).toMatchObject({ id: receipt.taskId, status: 'working', currentRequestId: receipt.id })
  const progress = await call(`/${receipt.taskId}/status`, { status: 'waiting', message: 'Waiting on CI.' })
  expect(progress.status).toBe(200)
  const body = await progress.json()
  expect(body.task).toMatchObject({ id: receipt.taskId, status: 'waiting' })
  const [update] = await db.select().from(assistantUpdates).where(eq(assistantUpdates.messageId, body.messageId))
  expect(update).toMatchObject({ taskId: receipt.taskId, requestId: receipt.id, reportedStatus: 'waiting' })
  expect((await InboxMessage.mustFind(body.messageId)).content).toBe('Waiting on CI.')
  // The default message is a short status line; the report follows the task's current request.
  const question = await f.update(receipt.id, 'Which region?', 'needs-input')
  const answer = await (
    await f.request(`/${f.id}/messages`, {
      clientId: randomUUID(),
      request: 'us-east',
      agentId: f.agent.id,
      inReplyTo: question.id,
    })
  ).json()
  const done = await call(`/${receipt.taskId}/status`, { status: 'completed' })
  expect(done.status).toBe(200)
  const [final] = await db
    .select()
    .from(assistantUpdates)
    .where(eq(assistantUpdates.messageId, (await done.json()).messageId))
  expect(final.requestId).toBe(answer.id)
  expect((await InboxMessage.mustFind(final.messageId)).content).toBe('Task status: completed')
  expect((await f.task(receipt.taskId)).status).toBe('completed')
  // A finished task refuses reports that would change it, without recording a no-op update.
  const updatesBefore = (await db.select().from(assistantUpdates).where(eq(assistantUpdates.conversationId, f.id)))
    .length
  const reopen = await call(`/${receipt.taskId}/status`, { status: 'working' })
  expect(reopen.status).toBe(409)
  expect(await reopen.json()).toMatchObject({ task: { id: receipt.taskId, status: 'completed' } })
  expect((await f.task(receipt.taskId)).status).toBe('completed')
  expect(await db.select().from(assistantUpdates).where(eq(assistantUpdates.conversationId, f.id))).toHaveLength(
    updatesBefore
  )
  // Restating the same terminal status is an ordinary update and still accepted.
  expect((await call(`/${receipt.taskId}/status`, { status: 'completed', message: 'Confirmed.' })).status).toBe(200)
  // Other agents, users, unknown tasks, and bad statuses are refused.
  const stranger = await Agent.create({ agentTypeId: 'system-manager', ownerUserId: f.owner.id, context: {} })
  agentIds.push(stranger.id)
  const strangerToken = await createTestAgentToken({ agentId: stranger.id, squadId: null })
  expect((await call(`/${receipt.taskId}`, undefined, strangerToken.token)).status).toBe(404)
  expect((await call(`/${receipt.taskId}/status`, { status: 'failed' }, strangerToken.token)).status).toBe(404)
  expect((await call(`/${receipt.taskId}/status`, { status: 'failed' }, f.owner.token)).status).toBe(404)
  expect((await call(`/${randomUUID()}/status`, { status: 'failed' })).status).toBe(404)
  expect((await call(`/${receipt.taskId}/status`, { status: 'done' })).status).toBe(400)
  expect(formatInboxMessages([await InboxMessage.mustFind(receipt.id)])).toContain(
    `tau assistant-task status ${receipt.taskId}`
  )
})
