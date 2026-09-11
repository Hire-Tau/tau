import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { like } from 'drizzle-orm'
import { rm } from 'fs/promises'
import { Hono } from 'hono'
import { db, squads } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { getSquadSshPath } from '../services/squad/ssh'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { squadSshRouter } from './squad-ssh'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/squads/ssh', squadSshRouter)

const rbacPrefix = `squad-ssh-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('squad-ssh routes', () => {
  let testPrefix: string
  let squadId: string

  beforeEach(async () => {
    testPrefix = `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const [squad] = await db
      .insert(squads)
      .values({ name: `${testPrefix} Test Squad`, purpose: 'Test squad for ssh routes', status: 'active' })
      .returning()
    squadId = squad.id
  })

  afterEach(async () => {
    await rm(getSquadSshPath(squadId), { recursive: true, force: true })
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  it('returns 401 without identity', async () => {
    const res = await app.request(`/api/squads/ssh/${squadId}/config`)
    expect(res.status).toBe(401)
  })

  it('denies users without ssh permission', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const res = await app.request(`/api/squads/ssh/${squadId}/config`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
  })

  it('denies squad ssh access outside the assigned squad scope', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ prefix: rbacPrefix, permissions: ['ssh:read'] })
    await assignRole({
      userId: user.id,
      roleId: role.id,
      scope: 'squad',
      squadId: '00000000-0000-0000-0000-000000000000',
    })

    const res = await app.request(`/api/squads/ssh/${squadId}/config`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(403)
  })

  it('allows an admin to write and read SSH config', async () => {
    const writeRes = await app.request(`/api/squads/ssh/${squadId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ config: 'Host example\n  HostName example.com' }),
    })
    expect(writeRes.status).toBe(200)

    const readRes = await app.request(`/api/squads/ssh/${squadId}/config`, {
      headers: authHeaders(admin.token),
    })
    expect(readRes.status).toBe(200)
    const data = await readRes.json()
    expect(data.config).toBe('Host example\n  HostName example.com')
  })

  it('allows squad-scoped readers to list keys for their squad', async () => {
    const user = await createTestUser({ prefix: rbacPrefix })
    const role = await createTestRole({ prefix: rbacPrefix, permissions: ['ssh:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })

    const res = await app.request(`/api/squads/ssh/${squadId}/keys`, {
      headers: authHeaders(user.token),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
