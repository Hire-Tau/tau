import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import { squadRelationshipsRouter } from './squad-relationships'
import { squadsRouter } from './squads'
import { identityMiddleware } from '../middleware/identity'
import { Squad } from '../entities/Squad'
import { AgentType } from '../entities/AgentType'
import { agentTokens, agents, db, roles, squads, squadRelationships } from '../db'
import {
  createTestAdmin,
  createTestAgentToken,
  authHeaders,
  cleanupTestRbac,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { Agent } from '../entities/Agent'
import { RoleSync } from '../services/config-sync/role-sync'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads', squadsRouter)
app.route('/api/squad-relationships', squadRelationshipsRouter)

const srPrefix = `sr-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let unprivileged: TestUser

beforeAll(async () => {
  await new RoleSync().sync()
  // The communication-safe projection test writes typeContext: { manager: … },
  // and Squad.normalizeTypeContext validates keys against agent_types whenever
  // the table is non-empty — so seed the referenced type ourselves (the
  // Squad.test.ts pattern) instead of depending on earlier suites leaving the
  // table empty. Reproduced: any earlier file leaking a non-'manager' row made
  // this suite throw 'Unknown agent type ID(s) in typeContext: manager'.
  await AgentType.upsert({
    id: 'manager',
    name: 'Manager',
    systemPrompt: 'You are a manager.',
    model: 'anthropic:claude-sonnet-4-5',
  })
  admin = await createTestAdmin({ prefix: srPrefix })
  unprivileged = await createTestUser({ prefix: srPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(srPrefix)
  await db
    .delete(roles)
    .where(inArray(roles.slug, ['admin', 'operator', 'viewer', 'default-worker', 'default-manager']))
})

describe('squad-relationships routes', () => {
  let testPrefix: string
  let squad1: Squad
  let squad2: Squad
  let squad3: Squad
  let consultant: Agent
  let managerToken: string
  let consultantToken: string

  beforeEach(async () => {
    testPrefix = `route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    squad1 = await Squad.create({
      name: `${testPrefix} Leadership`,
      purpose: 'Organization leadership',
    })
    squad2 = await Squad.create({
      name: `${testPrefix} Engineering`,
      purpose: 'Engineering work',
    })
    squad3 = await Squad.create({
      name: `${testPrefix} Marketing`,
      purpose: 'Marketing work',
    })

    consultant = await Agent.create({ agentTypeId: 'consultant', squadId: squad1.id })
    managerToken = (await createTestAgentToken({ agentId: squad1.managerAgentId!, squadId: squad1.id })).token
    consultantToken = (await createTestAgentToken({ agentId: consultant.id, squadId: squad1.id })).token
  })

  afterEach(async () => {
    await db.delete(squadRelationships)
    await db.delete(agentTokens).where(inArray(agentTokens.agentId, [squad1.managerAgentId!, consultant.id]))
    await db.delete(agents).where(inArray(agents.id, [consultant.id]))
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  describe('POST /api/squad-relationships', () => {
    it('creates a relationship', async () => {
      const res = await app.request('/api/squad-relationships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          sourceSquadId: squad2.id,
          targetSquadId: squad1.id,
          relationshipType: 'reports_to',
        }),
      })

      expect(res.status).toBe(201)
      const rel = await res.json()
      expect(rel.sourceSquadId).toBe(squad2.id)
      expect(rel.targetSquadId).toBe(squad1.id)
      expect(rel.relationshipType).toBe('reports_to')
    })

    it('returns 400 for self-relationship', async () => {
      const res = await app.request('/api/squad-relationships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          sourceSquadId: squad1.id,
          targetSquadId: squad1.id,
          relationshipType: 'collaborates',
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('itself')
    })

    it('returns 400 for invalid relationship type', async () => {
      const res = await app.request('/api/squad-relationships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          sourceSquadId: squad2.id,
          targetSquadId: squad1.id,
          relationshipType: 'invalid_type',
        }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 for missing fields', async () => {
      const res = await app.request('/api/squad-relationships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          sourceSquadId: squad2.id,
        }),
      })

      expect(res.status).toBe(400)
    })

    it('denies unprivileged relationship writes', async () => {
      const res = await app.request('/api/squad-relationships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(unprivileged.token) },
        body: JSON.stringify({
          sourceSquadId: squad2.id,
          targetSquadId: squad1.id,
          relationshipType: 'reports_to',
        }),
      })

      expect(res.status).toBe(403)
    })

    it('returns 400 for non-existent squad', async () => {
      const res = await app.request('/api/squad-relationships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({
          sourceSquadId: '00000000-0000-0000-0000-000000000000',
          targetSquadId: squad1.id,
          relationshipType: 'reports_to',
        }),
      })

      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/squad-relationships', () => {
    it.each([
      ['manager', () => managerToken],
      ['consultant', () => consultantToken],
    ])('allows %s to read relationships for its own squad', async (_type, token) => {
      const relationship = await squad1.addRelationship(squad2.id, 'collaborates')

      const res = await app.request(`/api/squad-relationships?squadId=${squad1.id}`, {
        headers: authHeaders(token()),
      })

      expect(res.status).toBe(200)
      const returned = await res.json()
      expect(returned).toHaveLength(1)
      expect(returned[0]).toMatchObject({
        id: relationship.id,
        sourceSquadId: squad1.id,
        targetSquadId: squad2.id,
        relationshipType: 'collaborates',
      })
    })

    it.each([
      ['manager', () => managerToken],
      ['consultant', () => consultantToken],
    ])('denies %s relationship reads for a related squad', async (_type, token) => {
      await squad1.addRelationship(squad2.id, 'collaborates')

      const res = await app.request(`/api/squad-relationships?squadId=${squad2.id}`, {
        headers: authHeaders(token()),
      })

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })

    it.each([
      ['manager', () => managerToken],
      ['consultant', () => consultantToken],
    ])('denies %s relationship reads for an unrelated squad', async (_type, token) => {
      await squad1.addRelationship(squad2.id, 'collaborates')

      const res = await app.request(`/api/squad-relationships?squadId=${squad3.id}`, {
        headers: authHeaders(token()),
      })

      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })

    it('returns relationships for a squad', async () => {
      await squad2.addRelationship(squad1.id, 'reports_to')
      await squad2.addRelationship(squad3.id, 'collaborates')

      const res = await app.request(`/api/squad-relationships?squadId=${squad2.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const rels = await res.json()
      expect(rels.length).toBe(2)
    })

    it('filters by relationship type', async () => {
      await squad2.addRelationship(squad1.id, 'reports_to')
      await squad2.addRelationship(squad3.id, 'collaborates')

      const res = await app.request(`/api/squad-relationships?squadId=${squad2.id}&type=reports_to`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const rels = await res.json()
      expect(rels.length).toBe(1)
      expect(rels[0].relationshipType).toBe('reports_to')
    })

    it('denies unprivileged relationship reads', async () => {
      const res = await app.request(`/api/squad-relationships?squadId=${squad2.id}`, {
        headers: authHeaders(unprivileged.token),
      })
      expect(res.status).toBe(403)
    })

    it('returns 400 when squadId is missing', async () => {
      const res = await app.request('/api/squad-relationships', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('squadId')
    })
  })

  describe('DELETE /api/squad-relationships/:id', () => {
    it('deletes a relationship', async () => {
      const rel = await squad2.addRelationship(squad1.id, 'reports_to')

      const res = await app.request(`/api/squad-relationships/${rel.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(204)

      // Verify it's gone
      const checkRes = await app.request(`/api/squad-relationships?squadId=${squad2.id}`, {
        headers: authHeaders(admin.token),
      })
      const rels = await checkRes.json()
      expect(rels.length).toBe(0)
    })

    it('denies unprivileged relationship deletes', async () => {
      const rel = await squad2.addRelationship(squad1.id, 'reports_to')

      const res = await app.request(`/api/squad-relationships/${rel.id}`, {
        method: 'DELETE',
        headers: authHeaders(unprivileged.token),
      })
      expect(res.status).toBe(403)
    })

    it('returns 204 for non-existent relationship (idempotent)', async () => {
      const res = await app.request('/api/squad-relationships/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(204)
    })
  })

  describe('GET /api/squads/:id/relationships', () => {
    it('returns only the communication-safe projection for foreign squads', async () => {
      await squad2.update({
        context: 'route-explicit-context-secret',
        typeContext: { manager: 'route-explicit-type-context-secret' },
        metadata: { secret: 'route-explicit-metadata-secret' },
      })
      await squad3.update({
        context: 'route-global-context-secret',
        typeContext: { manager: 'route-global-type-context-secret' },
        metadata: { secret: 'route-global-metadata-secret' },
        globalCollaborationEnabled: true,
      })
      await squad1.addRelationship(squad2.id, 'collaborates')

      const res = await app.request(`/api/squads/${squad1.id}/relationships`, {
        headers: authHeaders(managerToken),
      })

      expect(res.status).toBe(200)
      const relationships = await res.json()
      const explicit = relationships.collaborates.find((candidate: { id: string }) => candidate.id === squad2.id)
      const global = relationships.collaborates.find((candidate: { id: string }) => candidate.id === squad3.id)
      expect(explicit).toEqual({
        id: squad2.id,
        managerAgentId: squad2.managerAgentId,
        name: squad2.name,
        purpose: squad2.purpose,
      })
      expect(global).toEqual({
        id: squad3.id,
        managerAgentId: squad3.managerAgentId,
        name: squad3.name,
        purpose: squad3.purpose,
      })
      expect(Object.keys(explicit).sort()).toEqual(['id', 'managerAgentId', 'name', 'purpose'])
      expect(Object.keys(global).sort()).toEqual(['id', 'managerAgentId', 'name', 'purpose'])

      const serialized = JSON.stringify(relationships)
      expect(serialized).not.toContain('route-explicit-context-secret')
      expect(serialized).not.toContain('route-explicit-type-context-secret')
      expect(serialized).not.toContain('route-explicit-metadata-secret')
      expect(serialized).not.toContain('route-global-context-secret')
      expect(serialized).not.toContain('route-global-type-context-secret')
      expect(serialized).not.toContain('route-global-metadata-secret')
    })

    it('returns categorized relationships', async () => {
      // Engineering reports to Leadership
      await squad2.addRelationship(squad1.id, 'reports_to')
      // Engineering collaborates with Marketing
      await squad2.addRelationship(squad3.id, 'collaborates')

      const res = await app.request(`/api/squads/${squad2.id}/relationships`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const rels = await res.json()

      expect(rels.reportsTo.length).toBe(1)
      expect(rels.reportsTo[0].id).toBe(squad1.id)
      expect(rels.collaborates.length).toBe(1)
      expect(rels.collaborates[0].id).toBe(squad3.id)
      expect(rels.dependsOn).toEqual([])
      expect(rels.reportedBy).toEqual([])
      expect(rels.dependedOnBy).toEqual([])
    })

    it('includes global squads as collaborators without relationship rows', async () => {
      await squad3.update({ globalCollaborationEnabled: true })

      const res = await app.request(`/api/squads/${squad2.id}/relationships`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const rels = await res.json()
      expect(rels.collaborates.map((s: { id: string }) => s.id)).toContain(squad3.id)

      const persistedRes = await app.request(`/api/squad-relationships?squadId=${squad2.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(persistedRes.status).toBe(200)
      expect(await persistedRes.json()).toHaveLength(0)
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000/relationships', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/squads/:id/can-communicate/:otherId', () => {
    it('returns true for related squads', async () => {
      await squad2.addRelationship(squad1.id, 'reports_to')

      const res = await app.request(`/api/squads/${squad1.id}/can-communicate/${squad2.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.canCommunicate).toBe(true)
    })

    it('returns false for unrelated squads', async () => {
      const res = await app.request(`/api/squads/${squad1.id}/can-communicate/${squad3.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.canCommunicate).toBe(false)
    })

    it('returns true for a global squad without relationship rows', async () => {
      await squad3.update({ globalCollaborationEnabled: true })

      const res = await app.request(`/api/squads/${squad2.id}/can-communicate/${squad3.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ canCommunicate: true })

      const persistedRes = await app.request(`/api/squad-relationships?squadId=${squad2.id}`, {
        headers: authHeaders(admin.token),
      })
      expect(await persistedRes.json()).toHaveLength(0)
    })
  })
})
