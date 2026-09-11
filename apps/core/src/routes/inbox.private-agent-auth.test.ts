import { expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { readdir } from 'fs/promises'
import { dirname } from 'path'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agentTokens, agents, agentTypes, db, inbox, squads, systemTokens } from '../db'
import { InboxAttachment } from '../entities/InboxAttachment'
import { createSystemToken } from '../services/auth/system-tokens'
import { inboxAttachmentPath } from '../services/inbox/attachment-storage'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestAgentToken, createTestUser } from '../test-utils'
import { inboxRouter } from './inbox'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/inbox', inboxRouter)

test('keeps private agent inbox content owner-exclusive', async () => {
  const prefix = `private-inbox-${randomUUID()}`
  const owner = await createTestUser({ prefix })
  const foreignAdmin = await createTestAdmin({ prefix })
  const foreignUser = await createTestUser({ prefix })
  const agentId = randomUUID()
  const unownedAgentId = randomUUID()
  const tokenSquadId = randomUUID()
  const squadSelfId = randomUUID()
  const squadManagerId = randomUUID()
  const squadManagerTypeId = `${prefix}-manager-type`
  const tokenIds: string[] = []
  let messageId: string | undefined
  let unownedMessageId: string | undefined
  let squadMessageId: string | undefined
  const remainingAttachments: InboxAttachment[] = []
  let systemTokenId: string | undefined

  try {
    await db.insert(agentTypes).values({
      id: squadManagerTypeId,
      name: `${prefix} manager`,
      model: 'test:model',
      systemPrompt: 'test',
      extraScopes: ['inbox:read-squad'],
    })
    await db.insert(squads).values({ id: tokenSquadId, name: `${prefix}-tokens`, purpose: 'test' })
    await db.insert(agents).values([
      { id: agentId, agentTypeId: 'system-manager', ownerUserId: owner.id },
      { id: unownedAgentId, agentTypeId: 'artifact-builder' },
      { id: squadSelfId, agentTypeId: 'artifact-builder', squadId: tokenSquadId },
      { id: squadManagerId, agentTypeId: squadManagerTypeId, squadId: tokenSquadId },
    ])
    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: agentId,
        senderType: 'system',
        content: `${prefix}-secret`,
      })
      .returning()
    messageId = message.id
    const [unownedMessage] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: unownedAgentId,
        senderType: 'system',
        content: `${prefix}-unowned`,
      })
      .returning()
    unownedMessageId = unownedMessage.id
    const [squadMessage] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: squadSelfId,
        senderType: 'system',
        content: `${prefix}-squad`,
      })
      .returning()
    squadMessageId = squadMessage.id
    const ownerAgentToken = await createTestAgentToken({ agentId, squadId: tokenSquadId, userId: owner.id })
    const malformedSelfToken = await createTestAgentToken({ agentId, squadId: tokenSquadId })
    const squadSelfToken = await createTestAgentToken({ agentId: squadSelfId, squadId: tokenSquadId })
    const squadManagerToken = await createTestAgentToken({ agentId: squadManagerId, squadId: tokenSquadId })
    tokenIds.push(ownerAgentToken.id, malformedSelfToken.id, squadSelfToken.id, squadManagerToken.id)
    const systemInbox = await createSystemToken({
      name: `${prefix}-system`,
      scopes: ['inbox:read', 'inbox:write'],
    })
    systemTokenId = systemInbox.record.id
    const reclaimAttachment = await InboxAttachment.create({
      messageId: message.id,
      filename: 'reclaim.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('private quota bytes'),
    })
    const protectedAttachment = await InboxAttachment.create({
      messageId: message.id,
      filename: 'protected.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('neighbor bytes'),
    })
    const systemReclaimAttachment = await InboxAttachment.create({
      messageId: message.id,
      filename: 'system-reclaim.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('system quota bytes'),
    })
    remainingAttachments.push(reclaimAttachment, protectedAttachment, systemReclaimAttachment)

    for (const token of [foreignAdmin.token, foreignUser.token, systemInbox.token, malformedSelfToken.token]) {
      for (const path of [
        `/api/inbox/agent/${agentId}`,
        `/api/inbox/agent/${agentId}?limit=10`,
        `/api/inbox/agent/${agentId}/count`,
        `/api/inbox/message/${message.id}`,
      ]) {
        const denied = await app.request(path, { headers: authHeaders(token) })
        expect(denied.status).toBe(403)
        expect(await denied.json()).toEqual({ error: 'Forbidden' })
      }
    }

    const deniedTokens = [foreignAdmin.token, foreignUser.token, systemInbox.token, malformedSelfToken.token]
    for (const token of deniedTokens) {
      for (const entry of [
        { path: `/api/inbox/${message.id}/read`, method: 'POST' },
        { path: `/api/inbox/agent/${agentId}/read-all`, method: 'POST' },
      ]) {
        const denied = await app.request(entry.path, {
          method: entry.method,
          headers: authHeaders(token),
        })
        expect(denied.status).toBe(403)
      }
      expect((await db.select().from(inbox).where(eq(inbox.id, message.id)))[0]?.readAt).toBeNull()

      const beforeDeniedUpload = await InboxAttachment.listForMessage(message.id)
      const attachmentDir = dirname(inboxAttachmentPath(message.id, 'snapshot'))
      const beforeDeniedBlobs = (await readdir(attachmentDir)).sort()
      const deniedForm = new FormData()
      deniedForm.set('file', new File(['denied bytes'], 'denied.txt', { type: 'text/plain' }))
      const deniedUpload = await app.request(`/api/inbox/${message.id}/attachments`, {
        method: 'POST',
        headers: authHeaders(token),
        body: deniedForm,
      })
      expect(deniedUpload.status).toBe(403)
      expect(await InboxAttachment.listForMessage(message.id)).toHaveLength(beforeDeniedUpload.length)
      expect((await readdir(attachmentDir)).sort()).toEqual(beforeDeniedBlobs)
    }

    const malformedSelf = await app.request(`/api/inbox/agent/${agentId}`, {
      headers: authHeaders(malformedSelfToken.token),
    })
    expect(malformedSelf.status).toBe(403)

    for (const token of [foreignAdmin.token, systemInbox.token]) {
      const unownedAllowed = await app.request(`/api/inbox/agent/${unownedAgentId}`, {
        headers: authHeaders(token),
      })
      expect(unownedAllowed.status).toBe(200)
      expect((await unownedAllowed.json()).map((row: { id: string }) => row.id)).toContain(unownedMessage.id)
    }
    const unownedDenied = await app.request(`/api/inbox/agent/${unownedAgentId}`, {
      headers: authHeaders(malformedSelfToken.token),
    })
    expect(unownedDenied.status).toBe(403)

    for (const token of [squadSelfToken.token, squadManagerToken.token]) {
      const squadAllowed = await app.request(`/api/inbox/agent/${squadSelfId}`, {
        headers: authHeaders(token),
      })
      expect(squadAllowed.status).toBe(200)
      expect((await squadAllowed.json()).map((row: { id: string }) => row.id)).toContain(squadMessage.id)
    }

    for (const token of [foreignAdmin.token, foreignUser.token, systemInbox.token, malformedSelfToken.token]) {
      const deniedDownload = await app.request(`/api/inbox/attachments/${reclaimAttachment.id}`, {
        headers: authHeaders(token),
      })
      expect(deniedDownload.status).toBe(403)
    }
    const deniedReclaim = await app.request(`/api/inbox/attachments/${protectedAttachment.id}`, {
      method: 'DELETE',
      headers: authHeaders(malformedSelfToken.token),
    })
    expect(deniedReclaim.status).toBe(403)
    const reclaimed = await app.request(`/api/inbox/attachments/${reclaimAttachment.id}`, {
      method: 'DELETE',
      headers: authHeaders(foreignAdmin.token),
    })
    expect(reclaimed.status).toBe(200)
    remainingAttachments.shift()
    expect(await InboxAttachment.findById(reclaimAttachment.id)).toBeNull()
    const systemReclaimed = await app.request(`/api/inbox/attachments/${systemReclaimAttachment.id}`, {
      method: 'DELETE',
      headers: authHeaders(systemInbox.token),
    })
    expect(systemReclaimed.status).toBe(200)
    remainingAttachments.splice(1, 1)
    expect(await InboxAttachment.findById(systemReclaimAttachment.id)).toBeNull()
    expect(await InboxAttachment.findById(protectedAttachment.id)).not.toBeNull()

    for (const token of [owner.token, ownerAgentToken.token]) {
      const ownerList = await app.request(`/api/inbox/agent/${agentId}?includeRead=true`, {
        headers: authHeaders(token),
      })
      expect(ownerList.status).toBe(200)
      expect((await ownerList.json()).map((row: { id: string }) => row.id)).toContain(message.id)
      for (const entry of [
        { path: `/api/inbox/agent/${agentId}?limit=10&includeRead=true`, method: 'GET' },
        { path: `/api/inbox/agent/${agentId}/count`, method: 'GET' },
        { path: `/api/inbox/message/${message.id}`, method: 'GET' },
        { path: `/api/inbox/${message.id}/read`, method: 'POST' },
        { path: `/api/inbox/agent/${agentId}/read-all`, method: 'POST' },
        { path: `/api/inbox/attachments/${protectedAttachment.id}`, method: 'GET' },
      ]) {
        const ownerResponse = await app.request(entry.path, {
          method: entry.method,
          headers: authHeaders(token),
        })
        expect(ownerResponse.status).toBe(200)
      }
    }
    for (const [label, token] of [
      ['owner-session', owner.token],
      ['owner-agent', ownerAgentToken.token],
    ] as const) {
      const ownerForm = new FormData()
      ownerForm.set('file', new File([`${label} bytes`], `${label}.txt`, { type: 'text/plain' }))
      const ownerUpload = await app.request(`/api/inbox/${message.id}/attachments`, {
        method: 'POST',
        headers: authHeaders(token),
        body: ownerForm,
      })
      expect(ownerUpload.status).toBe(201)
      const uploaded = await InboxAttachment.findById((await ownerUpload.json()).id)
      expect(uploaded).not.toBeNull()
      if (uploaded) remainingAttachments.push(uploaded)
    }

    for (const path of [`/api/inbox/message/${randomUUID()}`, `/api/inbox/attachments/${randomUUID()}`]) {
      const missing = await app.request(path, { headers: authHeaders(foreignAdmin.token) })
      expect(missing.status).toBe(403)
      expect(await missing.json()).toEqual({ error: 'Forbidden' })
      expect((await app.request(path)).status).toBe(401)
    }
    const missingDelete = await app.request(`/api/inbox/attachments/${randomUUID()}`, {
      method: 'DELETE',
      headers: authHeaders(foreignAdmin.token),
    })
    expect(missingDelete.status).toBe(403)
    expect(await missingDelete.json()).toEqual({ error: 'Forbidden' })
  } finally {
    for (const attachment of remainingAttachments) await attachment.delete().catch(() => {})
    if (messageId) await db.delete(inbox).where(eq(inbox.id, messageId))
    if (unownedMessageId) await db.delete(inbox).where(eq(inbox.id, unownedMessageId))
    if (squadMessageId) await db.delete(inbox).where(eq(inbox.id, squadMessageId))
    if (tokenIds.length)
      await db.delete(agentTokens).where(inArray(agentTokens.agentId, [agentId, squadSelfId, squadManagerId]))
    await db.delete(agents).where(inArray(agents.id, [agentId, unownedAgentId, squadSelfId, squadManagerId]))
    await db.delete(squads).where(eq(squads.id, tokenSquadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, squadManagerTypeId))
    if (systemTokenId) await db.delete(systemTokens).where(eq(systemTokens.id, systemTokenId))
    await cleanupTestRbac(prefix)
  }
})
