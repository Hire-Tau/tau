import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { operationsRecommendations, roleAssignments, squads } from '../db/schema'
import { identityMiddleware } from '../middleware/identity'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import { operationsRecommendationsRouter } from './recommendations'

const unauthApp = new Hono().route('/api/recommendations', operationsRecommendationsRouter)
const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/recommendations', operationsRecommendationsRouter)
const prefix = `recommendations-rbac-${Date.now()}`
let reader: TestUser
let updater: TestUser
/** Readable squad A + a role in squad B that does NOT carry recommendations:read. */
let partialReader: TestUser
let squadA: string
let squadB: string
let recommendationA: string
let recommendationB: string
const baseline = { sampleSize: 1, avgDurationMs: 10, avgTokens: 20, failedToolCalls: 1, estimatedAvoidableRetries: 0 }
async function request(user: TestUser, path: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`http://localhost/api/recommendations${path}`, {
      ...init,
      headers: { ...authHeaders(user.token), ...init.headers },
    })
  )
}
beforeAll(async () => {
  const [a, b] = await db
    .insert(squads)
    .values([
      { name: `${prefix}-a`, purpose: 'test' },
      { name: `${prefix}-b`, purpose: 'test' },
    ])
    .returning()
  squadA = a.id
  squadB = b.id
  const rows = await db
    .insert(operationsRecommendations)
    .values([
      {
        squadId: a.id,
        fingerprint: 'a'.repeat(64),
        remediationType: 'add_sandbox_package',
        target: 'jq',
        proposedRemediation: { type: 'add_sandbox_package', package: 'jq' },
        title: 'Add jq',
        summary: 'jq was unavailable',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        baseline,
        algorithmVersion: 'ops-heuristics-v1',
        redactionVersion: 'ops-redaction-v1',
      },
      {
        squadId: b.id,
        fingerprint: 'b'.repeat(64),
        remediationType: 'add_sandbox_package',
        target: 'curl',
        proposedRemediation: { type: 'add_sandbox_package', package: 'curl' },
        title: 'Add curl',
        summary: 'curl was unavailable',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        baseline,
        algorithmVersion: 'ops-heuristics-v1',
        redactionVersion: 'ops-redaction-v1',
      },
    ])
    .returning()
  recommendationA = rows[0].id
  recommendationB = rows[1].id
  reader = await createTestUser({ prefix })
  updater = await createTestUser({ prefix })
  const readRole = await createTestRole({ prefix, permissions: ['recommendations:read'] })
  const updateRole = await createTestRole({ prefix, permissions: ['recommendations:read', 'recommendations:update'] })
  await assignRole({ userId: reader.id, roleId: readRole.id, scope: 'squad', squadId: a.id })
  await assignRole({ userId: updater.id, roleId: updateRole.id, scope: 'squad', squadId: a.id })
  // getAccessibleSquadIds returns every squad the user holds ANY role in — it
  // does not filter on recommendations:read. This user therefore reaches the
  // list handler with squad B among its candidates while holding no
  // recommendation permission there, which is the only shape that exercises
  // the per-squad hasPermission filter rather than the squad-membership check.
  partialReader = await createTestUser({ prefix })
  const unrelatedRole = await createTestRole({ prefix, permissions: ['squads:read'] })
  await assignRole({ userId: partialReader.id, roleId: readRole.id, scope: 'squad', squadId: a.id })
  await assignRole({ userId: partialReader.id, roleId: unrelatedRole.id, scope: 'squad', squadId: b.id })
})
afterAll(async () => {
  await db.delete(squads).where(eq(squads.id, squadA))
  await db.delete(squads).where(eq(squads.id, squadB))
  await cleanupTestRbac(prefix)
})
describe('operations recommendations RBAC', () => {
  test('requires authentication', async () => {
    expect((await unauthApp.request('/api/recommendations')).status).toBe(401)
  })
  test('lists only recommendations in readable squads', async () => {
    const response = await request(reader, '')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([recommendationA])
    expect(body.items.map((item: { id: string }) => item.id)).not.toContain(recommendationB)
  })
  test('excludes an accessible squad the caller cannot read recommendations in', async () => {
    const response = await request(partialReader, '')
    expect(response.status).toBe(200)
    const ids = (await response.json()).items.map((item: { id: string }) => item.id)
    // Non-emptiness first: an empty page would satisfy the exclusion below on its own.
    expect(ids).toContain(recommendationA)
    expect(ids).not.toContain(recommendationB)
    // Explicitly asking for that squad is a 403, not a silent empty page.
    expect((await request(partialReader, `?squadId=${squadB}`)).status).toBe(403)
    expect((await request(partialReader, `/${recommendationB}`)).status).toBe(403)
  })
  test('returns a typed reset when permission changes between cursor pages', async () => {
    const cursorUser = await createTestUser({ prefix })
    const cursorRole = await createTestRole({ prefix, permissions: ['recommendations:read'] })
    await assignRole({ userId: cursorUser.id, roleId: cursorRole.id, scope: 'squad', squadId: squadA })
    await db.insert(operationsRecommendations).values({
      squadId: squadA,
      fingerprint: 'c'.repeat(64),
      remediationType: 'add_sandbox_package',
      target: 'git',
      proposedRemediation: { type: 'add_sandbox_package', package: 'git' },
      title: 'Add git',
      summary: 'git was unavailable',
      firstSeenAt: new Date(Date.now() - 1),
      lastSeenAt: new Date(Date.now() - 1),
      baseline,
      algorithmVersion: 'ops-heuristics-v1',
      redactionVersion: 'ops-redaction-v1',
    })
    const first = await request(cursorUser, '?limit=1')
    expect(first.status).toBe(200)
    const cursor = (await first.json()).nextCursor as string
    expect(cursor).toBeTruthy()
    await db
      .delete(roleAssignments)
      .where(and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, cursorUser.id)))
    const second = await request(cursorUser, `?limit=1&cursor=${encodeURIComponent(cursor)}`)
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ code: 'RECOMMENDATIONS_CURSOR_RESET_REQUIRED' })
  })

  test('rejects invalid ids and cursors before storage lookup', async () => {
    expect((await request(reader, '/not-a-uuid')).status).toBe(400)
    expect((await request(reader, '?cursor=not-json')).status).toBe(400)
  })
  test('denies cross-squad detail access', async () => {
    expect((await request(reader, `/${recommendationA}`)).status).toBe(200)
    expect((await request(reader, `/${recommendationB}`)).status).toBe(403)
  })
  test('enforces update permission on lifecycle PATCH', async () => {
    const init = {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged' }),
    }
    expect((await request(reader, `/${recommendationA}/status`, init)).status).toBe(403)
    const allowed = await request(updater, `/${recommendationA}/status`, init)
    expect(allowed.status).toBe(200)
    expect((await allowed.json()).status).toBe('acknowledged')
    expect((await request(updater, `/${recommendationB}/status`, init)).status).toBe(403)
  })
})
