import { describe, it, expect, afterAll, beforeAll, spyOn } from 'bun:test'
import { like } from 'drizzle-orm'
import { Hono } from 'hono'
import { rolesRouter } from './roles'
import { identityMiddleware } from '../middleware/identity'
import { db } from '../db'
import { roles } from '../db/schema'
import { Role } from '../entities/Role'
import { assignRole, createTestAdmin, createTestUser, authHeaders, cleanupTestRbac } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'
import { eventEmitter } from '../lib/infra/event-emitter'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/roles', rolesRouter)

const prefix = `role-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  await db.delete(roles).where(like(roles.slug, `${prefix}%`))
  await cleanupTestRbac(prefix)
})

describe('Security: system role permission immutability', () => {
  it('returns 403 when widening permissions of a non-readOnly system role', async () => {
    // operator/viewer are isSystem:true, readOnly:false in defaults.yaml.
    const role = await Role.create({
      name: `${prefix} Pseudo Operator`,
      slug: `${prefix}-sysrole`,
      permissions: ['squads:read'],
      isSystem: true,
    })
    const res = await app.request(`/api/roles/${role.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ permissions: ['agents:*'] }),
    })
    // Before the fix this returned 200 and widened the system role.
    expect(res.status).toBe(403)
    const after = await Role.findById(role.id)
    expect(after?.permissions).toEqual(['squads:read'])
  })
})

describe('Security: permission allowlist on create/update', () => {
  it('rejects global "*" in POST /api/roles with 400', async () => {
    const res = await app.request('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ name: 'Sneaky Admin', slug: `${prefix}-star`, permissions: ['*'] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects unknown permission strings with 400', async () => {
    const res = await app.request('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ name: 'Bogus', slug: `${prefix}-bogus`, permissions: ['totally:fake'] }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects "*" via PUT /api/roles/:id with 400', async () => {
    const role = await Role.create({
      name: 'Widenable',
      slug: `${prefix}-widen`,
      permissions: ['squads:read'],
      isSystem: false,
    })
    const res = await app.request(`/api/roles/${role.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ permissions: ['*'] }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts known bare + resource-wildcard permissions', async () => {
    const res = await app.request('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({
        name: 'Fine',
        slug: `${prefix}-fine`,
        permissions: ['squads:read', 'agents:*', 'secrets:read:integration'],
      }),
    })
    expect(res.status).toBe(201)
  })
})

describe('GET /api/roles', () => {
  it('lists all roles', async () => {
    await Role.create({ name: `${prefix} List Role`, slug: `${prefix}-list`, permissions: ['read'], isSystem: false })

    const res = await app.request('/api/roles', {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.some((r: any) => r.slug === `${prefix}-list`)).toBe(true)
  })
})

describe('GET /api/roles/:id', () => {
  it('returns a role by id', async () => {
    const role = await Role.create({
      name: `${prefix} Get Role`,
      slug: `${prefix}-get`,
      permissions: ['read'],
      isSystem: false,
    })

    const res = await app.request(`/api/roles/${role.id}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(role.id)
    expect(body.slug).toBe(`${prefix}-get`)
  })

  it('returns 404 for non-existent role', async () => {
    const res = await app.request('/api/roles/00000000-0000-0000-0000-000000000000', {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/roles', () => {
  it('creates a custom role', async () => {
    const res = await app.request('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({
        name: 'Custom Role',
        slug: `${prefix}-create`,
        permissions: ['squads:read', 'agents:read'],
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.slug).toBe(`${prefix}-create`)
    expect(body.isSystem).toBe(false)
    expect(body.permissions).toEqual(['squads:read', 'agents:read'])
    expect(body.updatedBy).toBeDefined()
  })

  it('rejects duplicate slug with 409', async () => {
    await Role.create({ name: 'Existing', slug: `${prefix}-dup`, permissions: [], isSystem: false })

    const res = await app.request('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ name: 'Duplicate', slug: `${prefix}-dup`, permissions: [] }),
    })
    expect(res.status).toBe(409)
  })

  it('returns 400 for invalid body (missing name)', async () => {
    const res = await app.request('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ slug: `${prefix}-bad`, permissions: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid body (non-array permissions)', async () => {
    const res = await app.request('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ name: 'Bad', slug: `${prefix}-badperms`, permissions: 'not-an-array' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/roles/:id', () => {
  it('updates permissions', async () => {
    const role = await Role.create({
      name: 'Updatable',
      slug: `${prefix}-update`,
      permissions: ['read'],
      isSystem: false,
    })

    const res = await app.request(`/api/roles/${role.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ permissions: ['squads:read', 'agents:read', 'monitors:read'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.permissions).toEqual(['squads:read', 'agents:read', 'monitors:read'])
    expect(body.updatedBy).toBe('admin')
  })

  it('returns 404 for non-existent role', async () => {
    const res = await app.request('/api/roles/00000000-0000-0000-0000-000000000000', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ permissions: [] }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 403 when updating a readOnly role', async () => {
    const role = await Role.create({
      name: 'ReadOnly PUT',
      slug: `${prefix}-readonly-put`,
      permissions: ['read'],
      isSystem: false,
      readOnly: true,
    })

    const res = await app.request(`/api/roles/${role.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      // allowlist-valid permission so we reach the readOnly guard (403), not 400
      body: JSON.stringify({ permissions: ['squads:read'] }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 400 for invalid body (non-array permissions)', async () => {
    const role = await Role.create({
      name: 'Valid Role',
      slug: `${prefix}-put-invalid`,
      permissions: ['read'],
      isSystem: false,
    })

    const res = await app.request(`/api/roles/${role.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ permissions: 'not-an-array' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/roles/:id Live Activity refresh', () => {
  it('refreshes each directly affected human user once after permission changes', async () => {
    const role = await Role.create({
      name: 'Live interest role',
      slug: `${prefix}-live-interest`,
      permissions: ['squads:read'],
      isSystem: false,
    })
    const first = await createTestUser({ prefix: `${prefix}-first` })
    const second = await createTestUser({ prefix: `${prefix}-second` })
    await assignRole({ userId: first.id, roleId: role.id, scope: 'system' })
    await assignRole({ userId: first.id, roleId: role.id, scope: 'squad_default' })
    await assignRole({ userId: second.id, roleId: role.id, scope: 'system' })

    const emit = spyOn(eventEmitter, 'emit')
    try {
      const res = await app.request(`/api/roles/${role.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ permissions: ['workstreams:read'] }),
      })
      expect(res.status).toBe(200)
      const refreshed = emit.mock.calls
        .filter(([event]) => event === 'liveActivity.interestChanged')
        .map(([, payload]) => (payload as { userId: string }).userId)
        .sort()
      expect(refreshed).toEqual([first.id, second.id].sort())

      emit.mockClear()
      const rename = await app.request(`/api/roles/${role.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
        body: JSON.stringify({ name: 'Renamed live interest role' }),
      })
      expect(rename.status).toBe(200)
      expect(emit.mock.calls.some(([event]) => event === 'liveActivity.interestChanged')).toBe(false)
    } finally {
      emit.mockRestore()
    }
  })
})

describe('DELETE /api/roles/:id', () => {
  it('refreshes each affected human user once after successful role deletion', async () => {
    const role = await Role.create({
      name: 'Deletable assigned role',
      slug: `${prefix}-delete-assigned`,
      permissions: ['workstreams:read'],
      isSystem: false,
    })
    const first = await createTestUser({ prefix: `${prefix}-delete-first` })
    const second = await createTestUser({ prefix: `${prefix}-delete-second` })
    await assignRole({ userId: first.id, roleId: role.id, scope: 'system' })
    await assignRole({ userId: first.id, roleId: role.id, scope: 'squad_default' })
    await assignRole({ userId: second.id, roleId: role.id, scope: 'system' })

    const emit = spyOn(eventEmitter, 'emit')
    try {
      const res = await app.request(`/api/roles/${role.id}`, {
        method: 'DELETE',
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(204)
      const refreshed = emit.mock.calls
        .filter(([event]) => event === 'liveActivity.interestChanged')
        .map(([, payload]) => (payload as { userId: string }).userId)
        .sort()
      expect(refreshed).toEqual([first.id, second.id].sort())
    } finally {
      emit.mockRestore()
    }
  })

  it('deletes a custom role', async () => {
    const role = await Role.create({ name: 'Deletable', slug: `${prefix}-delete`, permissions: [], isSystem: false })

    const res = await app.request(`/api/roles/${role.id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(204)

    const found = await Role.findById(role.id)
    expect(found).toBeNull()
  })

  it('prevents deleting system roles with 403', async () => {
    const role = await Role.create({ name: 'System', slug: `${prefix}-system`, permissions: [], isSystem: true })

    const res = await app.request(`/api/roles/${role.id}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(403)
  })
})
