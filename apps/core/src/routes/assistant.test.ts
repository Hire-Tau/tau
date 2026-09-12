import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray, or } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  assistantConversations,
  assistantConversationAgents,
  assistantEntries,
  agents,
  db,
  executions,
  inbox,
  squads,
} from '../db'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { InboxMessage, formatInboxMessages } from '../entities/InboxMessage'
import { assistantInboxRecipientId } from '@tau/shared'
import { inboxRouter } from './inbox'
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
  expect(first.pending).toBe(0)
  expect(first.messages.map((message: { id: string }) => message.id)).toEqual([reply.id])
  expect((await (await request(`/${id}/inbox`, { consumerId: second })).json()).acquired).toBe(false)
  expect((await request(`/${id}/inbox/ack`, { consumerId: second, messageId: reply.id })).status).toBe(409)
  await db
    .update(assistantConversations)
    .set({ inboxConsumerExpiresAt: new Date(0) })
    .where(eq(assistantConversations.id, id))
  expect((await (await request(`/${id}/inbox`, { consumerId: second })).json()).messages[0].content).toBe(reply.content)
  expect((await request(`/${id}/inbox/ack`, { consumerId, messageId: reply.id })).status).toBe(409)
  expect((await request(`/${id}/inbox/ack`, { consumerId: second, messageId: reply.id })).status).toBe(200)
  expect((await (await request(`/${id}/inbox`, { consumerId: second })).json()).messages).toEqual([])
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

test('squad delegations require squad chat permission and reject mixed targets', async () => {
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
