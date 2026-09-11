import { describe, it, expect, afterEach, spyOn, beforeEach, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { channelInstancesRouter } from './channel-instances'
import { ChannelInstance } from '../entities/ChannelInstance'
import { db, channelInstances, squads } from '../db'
import { eq } from 'drizzle-orm'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'

const prefix = `channel-instances-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let unprivileged: TestUser

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/channel-instances', channelInstancesRouter)

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  unprivileged = await createTestUser({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

function authReq(method = 'GET', body?: unknown) {
  return {
    method,
    headers: { ...authHeaders(admin.token), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }
}

async function guardRequest(path: string, init?: RequestInit, token?: string) {
  const headers = new Headers(init?.headers)
  if (token) {
    for (const [key, value] of Object.entries(authHeaders(token))) headers.set(key, value)
  }
  return app.request(path, { ...init, headers })
}

describe('channel-instances routes', () => {
  let listSpy: ReturnType<typeof spyOn>
  let findSpy: ReturnType<typeof spyOn>
  let createSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    await db
      .insert(squads)
      .values({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Export Default Squad',
        purpose: 'export test',
        status: 'active',
      })
      .onConflictDoNothing()
    await db
      .insert(channelInstances)
      .values({
        id: 'ci-export',
        name: 'Export Channel',
        provider: 'slack',
        providerConfig: { teamId: 'T123' },
        channelSquadMap: { C123: '22222222-2222-4222-8222-222222222222' },
        defaultSquadId: '11111111-1111-4111-8111-111111111111',
      })
      .onConflictDoNothing()
  })

  afterEach(async () => {
    listSpy?.mockRestore()
    findSpy?.mockRestore()
    createSpy?.mockRestore()
    await db.delete(channelInstances).where(eq(channelInstances.id, 'ci-export'))
    await db.delete(squads).where(eq(squads.id, '11111111-1111-4111-8111-111111111111'))
  })

  it('GET / returns list of channel instances with default routing fields', async () => {
    listSpy = spyOn(ChannelInstance, 'list' as any).mockResolvedValue([
      { id: 'inst-1', name: 'Acme Discord', provider: 'discord', channelSquadMap: {}, defaultSquadId: 's1' },
      { id: 'inst-2', name: 'Acme Slack', provider: 'slack', channelSquadMap: {}, defaultSquadId: 's2' },
    ])

    const res = await app.request('/channel-instances', authReq())
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data).toHaveLength(2)
    expect(data[0]).toEqual({
      id: 'inst-1',
      name: 'Acme Discord',
      provider: 'discord',
      channelSquadMap: {},
      defaultSquadId: 's1',
      yamlFieldOverrides: [],
      hasTemplate: false,
    })
    expect(Object.keys(data[0])).toEqual(
      expect.arrayContaining(['id', 'name', 'provider', 'channelSquadMap', 'defaultSquadId', 'yamlFieldOverrides'])
    )
  })

  it('POST / rejects missing defaultSquadId', async () => {
    const res = await app.request('/channel-instances', authReq('POST', { id: 'ci-x', name: 'X', provider: 'slack' }))

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/default squad/i)
  })

  it('POST / creates channel instances with defaultSquadId and channelSquadMap', async () => {
    findSpy = spyOn(ChannelInstance, 'find' as any).mockResolvedValue(null)
    createSpy = spyOn(ChannelInstance, 'create' as any).mockResolvedValue({ id: 'ci-y', name: 'Y', provider: 'slack' })

    const res = await app.request(
      '/channel-instances',
      authReq('POST', {
        id: 'ci-y',
        name: 'Y',
        provider: 'slack',
        defaultSquadId: 'a',
        channelSquadMap: { C1: 'b' },
      })
    )

    expect(res.status).toBe(201)
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ defaultSquadId: 'a', channelSquadMap: { C1: 'b' } })
    )
  })

  it('GET /:id/export returns YAML without linkedSquads', async () => {
    const res = await app.request('/channel-instances/ci-export/export', authReq())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/yaml')
    const yaml = await res.text()
    expect(yaml).toContain('id: ci-export')
    expect(yaml).toContain('provider: slack')
    expect(yaml).toContain('teamId: T123')
    expect(yaml).toContain('C123: 22222222-2222-4222-8222-222222222222')
    expect(yaml).toContain('defaultSquadId: 11111111-1111-4111-8111-111111111111')
    expect(yaml).not.toContain('linkedSquads')
  })

  it('GET /:id/export returns 404 for missing channel instance', async () => {
    const res = await app.request('/channel-instances/missing/export', authReq())

    expect(res.status).toBe(404)
  })

  it('GET / returns empty array when no instances', async () => {
    listSpy = spyOn(ChannelInstance, 'list' as any).mockResolvedValue([])

    const res = await app.request('/channel-instances', authReq())
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data).toEqual([])
  })
})

describe('channel-instances RBAC guards', () => {
  const readRoutes = [
    '/channel-instances',
    '/channel-instances/ci-export',
    '/channel-instances/ci-export/export',
    '/channel-instances/ci-export/template-diff',
  ]
  const updateRoutes: Array<[string, RequestInit]> = [
    ['/channel-instances/ci-export', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['/channel-instances/ci-export/revert-to-template', { method: 'POST' }],
    [
      '/channel-instances/ci-export/revert-template-fields',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    ],
    ['/channel-instances/ci-export/disable', { method: 'POST' }],
    ['/channel-instances/ci-export/enable', { method: 'POST' }],
  ]

  it('requires channels:read for read endpoints', async () => {
    for (const path of readRoutes) {
      expect((await guardRequest(path)).status).toBe(401)
      expect((await guardRequest(path, undefined, unprivileged.token)).status).toBe(403)
    }
  })

  it('allows admin to read channel instances', async () => {
    for (const path of readRoutes) {
      const res = await guardRequest(path, undefined, admin.token)
      expect([200, 404]).toContain(res.status)
    }
  })

  it('requires channels:create for creating channel instances', async () => {
    expect((await guardRequest('/channel-instances', { method: 'POST' })).status).toBe(401)
    expect((await guardRequest('/channel-instances', { method: 'POST' }, unprivileged.token)).status).toBe(403)
  })

  it('requires channels:update for mutating channel instance configuration', async () => {
    for (const [path, init] of updateRoutes) {
      expect((await guardRequest(path, init)).status).toBe(401)
      expect((await guardRequest(path, init, unprivileged.token)).status).toBe(403)
    }
  })

  it('requires channels:delete for deleting channel instances', async () => {
    expect((await guardRequest('/channel-instances/ci-export', { method: 'DELETE' })).status).toBe(401)
    expect((await guardRequest('/channel-instances/ci-export', { method: 'DELETE' }, unprivileged.token)).status).toBe(
      403
    )
  })
})
