import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, agents, squads, inbox, outbox } from '../db'
import { Agent } from '../entities/Agent'
import { InboxAttachment } from '../entities/InboxAttachment'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { inboxRouter } from './inbox'
import { getSettingsStore } from '../services/settings'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'

// Production-like app: sentinel wired exactly as in apps/core/src/index.ts
const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/inbox', inboxRouter)

const prefix = `inbox-fedatt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const PEER = 'peerinstfedatt0aaaaaaaaaaaaaaaa' // stand-in remote instance id (32 chars)
let admin: TestUser
let squadId: string
let home: string
const origHome = process.env.HOME_DIR

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  const [squad] = await db
    .insert(squads)
    .values({ name: `${prefix}-squad`, purpose: 'test' })
    .returning()
  squadId = squad.id
})

afterAll(async () => {
  await db.delete(squads).where(eq(squads.id, squadId))
  await cleanupTestRbac(prefix)
})

const createdAgentIds: string[] = []
const createdMessageIds: string[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'inbox-fedatt-'))
  process.env.HOME_DIR = home
  const store = getSettingsStore()
  await store.initialize()
  await store.set('INBOX_MAX_ATTACHMENT_BYTES', '10485760')
  await store.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '10737418240')
})

afterEach(async () => {
  if (origHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = origHome
  await rm(home, { recursive: true, force: true })

  await db.delete(outbox).where(eq(outbox.peerInstanceId, PEER))
  // inbox attachments cascade-delete from inbox rows (onDelete: 'cascade')
  for (const msgId of createdMessageIds.splice(0)) {
    await db.delete(inbox).where(eq(inbox.id, msgId))
  }
  for (const id of createdAgentIds.splice(0)) {
    await db.delete(inbox).where(eq(inbox.recipientId, id))
    await db.delete(agents).where(eq(agents.id, id))
  }
})

// Creates an agent in the test squad with a federation handle, owned by admin
// (admin has `*` permissions which includes amtp:send).
async function makeAgent(opts: { handle: string }) {
  // Owner on the agent ROW: since #1223 agent permissions resolve via the root
  // agent's ownerUserId, not the token's userId.
  const agent = await Agent.create({ agentTypeId: 'system-manager', squadId, ownerUserId: admin.id, context: {} })
  createdAgentIds.push(agent.id)
  await db.update(agents).set({ amtpHandle: opts.handle }).where(eq(agents.id, agent.id))
  const token = await createTestAgentToken({ agentId: agent.id, squadId, userId: admin.id })
  return { agent, token: token.token }
}

// Creates an inbox message addressed to the given recipient agent and seeds two attachments on it.
async function seedMessageWithAttachments(recipientAgentId: string) {
  const [msg] = await db
    .insert(inbox)
    .values({
      recipientType: 'agent',
      recipientId: recipientAgentId,
      senderType: 'agent',
      senderId: recipientAgentId,
      content: 'test message with attachments',
      deliveryMode: 'follow-up',
      metadata: {},
    })
    .returning()
  createdMessageIds.push(msg.id)

  const att1 = await InboxAttachment.create({
    messageId: msg.id,
    filename: 'file1.txt',
    contentType: 'text/plain',
    bytes: new TextEncoder().encode('hello'),
  })
  const att2 = await InboxAttachment.create({
    messageId: msg.id,
    filename: 'image.png',
    contentType: 'image/png',
    bytes: new Uint8Array([137, 80, 78, 71]),
  })
  return { msg, att1, att2 }
}

describe('POST /api/inbox — outbound federation with attachmentIds', () => {
  test('refs built correctly: attachmentIds resolved into envelope.attachments', async () => {
    const { agent, token } = await makeAgent({ handle: `${prefix}-sender1` })
    const { att1, att2 } = await seedMessageWithAttachments(agent.id)

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: `amtp://${PEER}/remote-handle`,
        content: 'sending with attachments',
        attachmentIds: [att1.id, att2.id],
      }),
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.enqueued).toBe(true)

    const [row] = await db.select().from(outbox).where(eq(outbox.id, body.outboxId))
    expect(row).toBeDefined()
    const env = row.envelopeJson as unknown as Record<string, unknown>
    const attachments = env.attachments as Array<Record<string, unknown>>
    expect(Array.isArray(attachments)).toBe(true)
    expect(attachments.length).toBe(2)

    expect(attachments[0]).toMatchObject({
      id: att1.id,
      filename: att1.filename,
      contentType: att1.contentType,
      byteSize: att1.byteSize,
      sha256: att1.sha256,
    })
    expect(attachments[1]).toMatchObject({
      id: att2.id,
      filename: att2.filename,
      contentType: att2.contentType,
      byteSize: att2.byteSize,
      sha256: att2.sha256,
    })
  })

  test('unknown attachmentId → 400, no outbox row enqueued', async () => {
    const { token } = await makeAgent({ handle: `${prefix}-sender2` })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: `amtp://${PEER}/remote-handle`,
        content: 'sending with bad id',
        attachmentIds: ['00000000-0000-0000-0000-000000000000'],
      }),
    })

    expect(res.status).toBe(400)
    const rows = await db.select().from(outbox).where(eq(outbox.peerInstanceId, PEER))
    expect(rows.length).toBe(0)
  })

  test('foreign wildcard-backed agent cannot reuse a private attachment', async () => {
    const { token: foreignAdminAgentToken } = await makeAgent({ handle: `${prefix}-sender3` })
    const privateOwner = await createTestUser({ prefix })
    const sendRole = await createTestRole({ prefix, permissions: ['amtp:send'] })
    await assignRole({ userId: privateOwner.id, roleId: sendRole.id, scope: 'system' })
    // The private agent stays SQUAD-LESS: cross-agent access to a squad-scoped
    // inbox is inbox:read-squad (which the foreign agent's wildcard backing
    // would satisfy, turning the 400 below vacuous); a squad-less owned agent
    // routes through hasAgentResourcePermission's ownership check instead.
    const privateAgent = await Agent.create({
      agentTypeId: 'system-manager',
      ownerUserId: privateOwner.id,
      context: {},
    })
    createdAgentIds.push(privateAgent.id)
    await db
      .update(agents)
      .set({ amtpHandle: `${prefix}-private` })
      .where(eq(agents.id, privateAgent.id))
    // Token squad must match the agent row's (null) squad: resolveAgentAuthority
    // (#1223) fails closed when they differ.
    const privateOwnerToken = await createTestAgentToken({
      agentId: privateAgent.id,
      squadId: null,
      userId: privateOwner.id,
    })
    const [privateMsg] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: privateAgent.id,
        senderType: 'agent',
        senderId: privateAgent.id,
        content: 'private owner message',
        deliveryMode: 'follow-up',
        metadata: {},
      })
      .returning()
    createdMessageIds.push(privateMsg.id)
    const attB = await InboxAttachment.create({
      messageId: privateMsg.id,
      filename: 'secret.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('top secret'),
    })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(foreignAdminAgentToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: `amtp://${PEER}/remote-handle`,
        content: 'trying to exfil',
        attachmentIds: [attB.id],
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Attachment not accessible' })
    expect(await db.select().from(outbox).where(eq(outbox.peerInstanceId, PEER))).toHaveLength(0)

    const ownerControl = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(privateOwnerToken.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: `amtp://${PEER}/remote-handle`,
        content: 'owner reuse',
        attachmentIds: [attB.id],
      }),
    })
    expect(ownerControl.status).toBe(202)
  })

  test('no attachmentIds → existing text-only behavior unchanged (regression)', async () => {
    const { token } = await makeAgent({ handle: `${prefix}-sender4` })

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: `amtp://${PEER}/remote-handle`,
        content: 'plain text, no attachments',
      }),
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    const [row] = await db.select().from(outbox).where(eq(outbox.id, body.outboxId))
    const env = row.envelopeJson as unknown as Record<string, unknown>
    expect(env.attachments).toBeUndefined()
  })

  test('attachmentIds on a local (non-amtp://) send → 400', async () => {
    const { agent, token } = await makeAgent({ handle: `${prefix}-sender5` })
    const { att1 } = await seedMessageWithAttachments(agent.id)

    const res = await app.request('/api/inbox', {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientType: 'agent',
        recipientId: agent.id, // local send
        content: 'local with attachmentIds',
        attachmentIds: [att1.id],
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('attachments on local sends use POST /:messageId/attachments')
  })
})
