import { expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agentTokens, agents, agentTypes, db, squads, systemTokens } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { createSystemToken } from '../services/auth/system-tokens'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestAgentToken, createTestUser } from '../test-utils'
import { agentsRouter } from './agents'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agents', agentsRouter)

test('enforces orphan agent REST policy', async () => {
  const prefix = `agent-orphan-${randomUUID()}`
  const squadId = randomUUID()
  const detachedSquadId = randomUUID()
  const foreignSquadId = randomUUID()
  const callerTypeId = `${prefix}-type`
  const callerId = randomUUID()
  const orphanId = randomUUID()
  const detachedId = randomUUID()
  const missingId = randomUUID()
  const sameSquadId = randomUUID()
  const foreignAgentId = randomUUID()
  let tokenId: string | undefined

  try {
    await db.insert(agentTypes).values({
      id: callerTypeId,
      name: `${prefix} caller`,
      model: 'test:model',
      systemPrompt: 'test',
      extraScopes: ['agents:read', 'agents:run', 'agents:delete'],
    })
    await db.insert(squads).values([
      { id: squadId, name: `${prefix} caller`, purpose: 'test' },
      { id: detachedSquadId, name: `${prefix} detached`, purpose: 'test' },
      { id: foreignSquadId, name: `${prefix} foreign`, purpose: 'test' },
    ])
    await db.insert(agents).values([
      { id: callerId, agentTypeId: callerTypeId, squadId },
      { id: orphanId, agentTypeId: 'artifact-builder' },
      { id: detachedId, agentTypeId: 'artifact-builder', squadId: detachedSquadId },
      { id: sameSquadId, agentTypeId: 'artifact-builder', squadId },
      { id: foreignAgentId, agentTypeId: 'artifact-builder', squadId: foreignSquadId },
    ])
    const callerToken = await createTestAgentToken({ agentId: callerId, squadId })
    tokenId = callerToken.id
    await db.delete(squads).where(eq(squads.id, detachedSquadId))
    expect((await db.select().from(agents).where(eq(agents.id, detachedId)))[0]?.squadId).toBeNull()

    for (const targetId of [orphanId, detachedId]) {
      for (const entry of [
        { method: 'GET', path: `/api/agents/${targetId}` },
        { method: 'GET', path: `/api/agents/${targetId}/messages` },
        { method: 'POST', path: `/api/agents/${targetId}/pause` },
      ]) {
        const response = await app.request(entry.path, {
          method: entry.method,
          headers: authHeaders(callerToken.token),
        })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Forbidden' })
      }
    }

    const sameDetail = await app.request(`/api/agents/${sameSquadId}`, {
      headers: authHeaders(callerToken.token),
    })
    expect(sameDetail.status).toBe(200)
    const samePause = await app.request(`/api/agents/${sameSquadId}/pause`, {
      method: 'POST',
      headers: authHeaders(callerToken.token),
    })
    expect(samePause.status).toBe(410)
    const foreignDetail = await app.request(`/api/agents/${foreignAgentId}`, {
      headers: authHeaders(callerToken.token),
    })
    expect(foreignDetail.status).toBe(403)

    const missing = await app.request(`/api/agents/${missingId}`, {
      headers: authHeaders(callerToken.token),
    })
    expect(missing.status).toBe(403)
    expect(await missing.json()).toEqual({ error: 'Forbidden' })
  } finally {
    if (tokenId) await db.delete(agentTokens).where(eq(agentTokens.id, tokenId))
    await db.delete(agents).where(inArray(agents.id, [callerId, orphanId, detachedId, sameSquadId, foreignAgentId]))
    await db.delete(squads).where(inArray(squads.id, [squadId, foreignSquadId]))
    await db.delete(agentTypes).where(eq(agentTypes.id, callerTypeId))
  }
})

test('enforces private agent hard-delete ownership', async () => {
  const prefix = `agent-private-delete-${randomUUID()}`
  const owner = await createTestUser({ prefix })
  const foreignAdmin = await createTestAdmin({ prefix })
  const privateForAdmin = randomUUID()
  const privateForOwner = randomUUID()
  const privateForOwnerAgent = randomUUID()
  const privateForSystem = randomUUID()
  const privateForUserless = randomUUID()
  const orphanForAdmin = randomUUID()
  const orphanForSystem = randomUUID()
  const tokenSquadId = randomUUID()
  const callerTypeId = `${prefix}-caller-type`
  const callerId = randomUUID()
  let callerTokenId: string | undefined
  let systemTokenId: string | undefined

  try {
    await db.insert(agentTypes).values({
      id: callerTypeId,
      name: `${prefix} caller`,
      model: 'test:model',
      systemPrompt: 'test',
      extraScopes: ['agents:delete'],
    })
    await db.insert(squads).values({ id: tokenSquadId, name: `${prefix}-tokens`, purpose: 'test' })
    await db.insert(agents).values([
      {
        id: privateForAdmin,
        agentTypeId: 'system-manager',
        ownerUserId: owner.id,
      },
      { id: privateForOwner, agentTypeId: 'system-manager', ownerUserId: owner.id },
      { id: privateForOwnerAgent, agentTypeId: 'system-manager', ownerUserId: owner.id },
      { id: privateForSystem, agentTypeId: 'system-manager', ownerUserId: owner.id },
      { id: privateForUserless, agentTypeId: 'system-manager', ownerUserId: owner.id },
      { id: orphanForAdmin, agentTypeId: 'artifact-builder' },
      { id: orphanForSystem, agentTypeId: 'artifact-builder' },
      { id: callerId, agentTypeId: callerTypeId, squadId: tokenSquadId },
    ])
    const callerToken = await createTestAgentToken({ agentId: callerId, squadId: tokenSquadId })
    callerTokenId = callerToken.id
    const ownerAgentToken = await createTestAgentToken({
      agentId: privateForOwnerAgent,
      squadId: tokenSquadId,
      userId: owner.id,
    })
    const systemDelete = await createSystemToken({ name: `${prefix}-system`, scopes: ['agents:delete'] })
    systemTokenId = systemDelete.record.id

    const denied = await app.request(`/api/agents/${privateForAdmin}`, {
      method: 'DELETE',
      headers: authHeaders(foreignAdmin.token),
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Forbidden' })
    for (const entry of [
      { id: privateForSystem, token: systemDelete.token },
      { id: privateForUserless, token: callerToken.token },
    ]) {
      const response = await app.request(`/api/agents/${entry.id}`, {
        method: 'DELETE',
        headers: authHeaders(entry.token),
      })
      expect(response.status).toBe(403)
      expect((await db.select().from(agents).where(eq(agents.id, entry.id))).length).toBe(1)
    }

    const allowed = await app.request(`/api/agents/${privateForOwner}`, {
      method: 'DELETE',
      headers: authHeaders(owner.token),
    })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ success: true, deleted: privateForOwner })
    expect(await db.select().from(agents).where(eq(agents.id, privateForOwner))).toHaveLength(0)
    const ownerAgentAllowed = await app.request(`/api/agents/${privateForOwnerAgent}`, {
      method: 'DELETE',
      headers: authHeaders(ownerAgentToken.token),
    })
    expect(ownerAgentAllowed.status).toBe(200)
    expect(await db.select().from(agents).where(eq(agents.id, privateForOwnerAgent))).toHaveLength(0)

    for (const entry of [
      { id: orphanForAdmin, token: foreignAdmin.token },
      { id: orphanForSystem, token: systemDelete.token },
    ]) {
      const response = await app.request(`/api/agents/${entry.id}`, {
        method: 'DELETE',
        headers: authHeaders(entry.token),
      })
      expect(response.status).toBe(200)
      expect(await db.select().from(agents).where(eq(agents.id, entry.id))).toHaveLength(0)
    }

    const missing = await app.request(`/api/agents/${randomUUID()}`, {
      method: 'DELETE',
      headers: authHeaders(foreignAdmin.token),
    })
    expect(missing.status).toBe(403)
    expect(await missing.json()).toEqual({ error: 'Forbidden' })
    const systemMissing = await app.request(`/api/agents/${randomUUID()}`, {
      method: 'DELETE',
      headers: authHeaders(systemDelete.token),
    })
    expect(systemMissing.status).toBe(403)
  } finally {
    if (callerTokenId) await db.delete(agentTokens).where(eq(agentTokens.id, callerTokenId))
    await db
      .delete(agents)
      .where(
        inArray(agents.id, [
          privateForAdmin,
          privateForOwner,
          privateForOwnerAgent,
          privateForSystem,
          privateForUserless,
          orphanForAdmin,
          orphanForSystem,
          callerId,
        ])
      )
    await db.delete(squads).where(eq(squads.id, tokenSquadId))
    await db.delete(agentTypes).where(eq(agentTypes.id, callerTypeId))
    if (systemTokenId) await db.delete(systemTokens).where(eq(systemTokens.id, systemTokenId))
    await cleanupTestRbac(prefix)
  }
})
