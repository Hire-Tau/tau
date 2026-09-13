import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, spyOn } from 'bun:test'
import { like } from 'drizzle-orm'
import { rm } from 'fs/promises'
import * as fs from 'fs'
import { Hono } from 'hono'
import { db, squads } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { ensureSquadSshDir, getSquadSshPath } from '../services/squad/ssh'
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

  for (const [method, endpoint, body] of [
    ['GET', 'keys', undefined],
    [
      'POST',
      'keys',
      {
        name: 'test-key',
        privateKey: ['-----BEGIN OPENSSH PRIVATE KEY-----', 'AAAA', '-----END OPENSSH PRIVATE KEY-----'].join('\n'),
      },
    ],
    ['PUT', 'config', { config: 'Host example' }],
    ['POST', 'known-hosts', { host: 'example ssh-ed25519 AAAA' }],
    ['PUT', 'known-hosts', { knownHosts: 'example ssh-ed25519 AAAA' }],
  ] as const) {
    it(`returns actionable JSON with 500 for directory permission failures on ${method} ${endpoint}`, async () => {
      const sshPath = ensureSquadSshDir(squadId)
      const originalChmodSync = fs.chmodSync
      const chmodSpy = spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
        if (path === sshPath) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
        return originalChmodSync(path, mode)
      })

      try {
        const res = await app.request(`/api/squads/ssh/${squadId}/${endpoint}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
          body: body ? JSON.stringify(body) : undefined,
        })
        expect(res.status).toBe(500)
        expect(res.headers.get('Content-Type')).toContain('application/json')
        const data = await res.json()
        expect(data.error).toContain(sshPath)
        expect(data.error).toContain(`owner UID ${process.geteuid!()} (GID ${process.getegid!()})`)
        expect(data.error).toContain('administrator')
        expect(data.error).toContain('0700')
      } finally {
        chmodSpy.mockRestore()
      }
    })
  }

  it('keeps invalid private keys as a client error', async () => {
    const res = await app.request(`/api/squads/ssh/${squadId}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ name: 'test-key', privateKey: 'not a private key' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Invalid SSH private key format')
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
