import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser } from '../test-utils'
import systemRouter from './system'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/system', systemRouter)
const prefix = `system-diagnostics-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const forbiddenKeyFragments = ['id', 'name', 'path', 'url', 'token', 'message', 'command', 'port']
const approvedAggregateKeys = new Set(['failed', 'pod_log_transport', 'port_forward'])

function findUnsafeKeys(value: unknown, location = 'response'): string[] {
  if (!value || typeof value !== 'object') return []
  const unsafe: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase()
    if (
      !approvedAggregateKeys.has(normalized) &&
      forbiddenKeyFragments.some((fragment) => normalized.includes(fragment))
    ) {
      unsafe.push(`${location}.${key}`)
    }
    unsafe.push(...findUnsafeKeys(child, `${location}.${key}`))
  }
  return unsafe
}

afterAll(() => cleanupTestRbac(prefix))

describe('GET /api/system/diagnostics', () => {
  test('requires an authenticated identity', async () => {
    expect((await app.request('/api/system/diagnostics')).status).toBe(401)
  })

  test('requires system:logs permission', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['inbox:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    expect((await app.request('/api/system/diagnostics', { headers: authHeaders(user.token) })).status).toBe(403)
  })

  test('returns only safe aggregate process and resource values', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['system:logs'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const response = await app.request('/api/system/diagnostics', { headers: authHeaders(user.token) })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['process', 'resources'])
    expect(body.process).toEqual({
      role: 'api',
      uptimeSeconds: expect.any(Number),
      rssBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
      externalBytes: expect.any(Number),
      arrayBufferBytes: expect.any(Number),
    })
    expect(findUnsafeKeys(body)).toEqual([])
    expect(body.resources).toEqual({
      sandbox_log_stream: expect.any(Object),
      pod_log_transport: expect.any(Object),
      port_forward: {
        active: expect.any(Number),
        started: expect.any(Number),
        completed: expect.any(Number),
        cancelled: expect.any(Number),
        failed: expect.any(Number),
        tracked: expect.any(Number),
        live: expect.any(Number),
        starting: expect.any(Number),
        admissionOwners: expect.any(Number),
      },
      websocket: { active: expect.any(Number) },
      websocket_subscription: { active: expect.any(Number) },
      recovery_watch: { active: expect.any(Number), oldestAgeSeconds: expect.any(Number) },
      local_event_forward: {
        channels: expect.arrayContaining([
          {
            channel: 'app_events',
            attempts: expect.any(Number),
            failures: {
              http_rejection: expect.any(Number),
              network: expect.any(Number),
              timeout: expect.any(Number),
            },
            lastFailure: null,
          },
        ]),
      },
    })
  })
})
