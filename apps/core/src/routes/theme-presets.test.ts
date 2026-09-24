import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { themePresetsRouter } from './theme-presets'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { authHeaders, cleanupTestRbac, createTestUser, type TestUser } from '../test-utils'
import { db, themePresets, users } from '../db'
import { THEME_PRESET_MAX_PER_USER } from '@tau/shared'

const prefix = `theme-presets-${crypto.randomUUID()}`
let a: TestUser
let b: TestUser
const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/theme-presets', themePresetsRouter)

const doc = (name = 'Mine') => ({
  format: 'tau-custom-theme',
  version: 2,
  name,
  base: 'harbor',
  variants: { light: {}, dark: { '--color-primary': '#0ea5e9' } },
})

const list = (user: TestUser) => app.request('/theme-presets', { headers: authHeaders(user.token) })
const get = (user: TestUser, id: string) => app.request(`/theme-presets/${id}`, { headers: authHeaders(user.token) })
const create = (user: TestUser, document: unknown) =>
  app.request('/theme-presets', {
    method: 'POST',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ document }),
  })
const update = (user: TestUser, id: string, revision: number, document: unknown) =>
  app.request(`/theme-presets/${id}`, {
    method: 'PUT',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, document }),
  })
const remove = (user: TestUser, id: string, revision: number) =>
  app.request(`/theme-presets/${id}`, {
    method: 'DELETE',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision }),
  })

beforeAll(async () => {
  a = await createTestUser({ prefix })
  b = await createTestUser({ prefix })
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})

test('anonymous access cannot read or mutate presets', async () => {
  for (const request of [
    () => app.request('/theme-presets'),
    () => app.request('/theme-presets/00000000-0000-4000-8000-000000000000'),
    () => app.request('/theme-presets', { method: 'POST' }),
  ])
    expect((await request()).status).toBe(401)
})

test('create, list, get, update (revision) and delete (revision) are owner-scoped', async () => {
  expect(await (await list(a)).json()).toEqual([])
  const created = await create(a, doc('First'))
  expect(created.status).toBe(201)
  const preset = await created.json()
  expect(preset).toMatchObject({ ownerUserId: a.id, visibility: 'private', revision: 1, document: doc('First') })
  expect(preset.id).toBeString()

  expect(await (await list(a)).json()).toEqual([preset])
  expect(await (await list(b)).json()).toEqual([])

  expect((await get(b, preset.id)).status).toBe(404) // another user's preset is invisible, not forbidden
  expect(await (await get(a, preset.id)).json()).toEqual(preset)

  const updated = await update(a, preset.id, 1, doc('Renamed'))
  expect(updated.status).toBe(200)
  const updatedBody = await updated.json()
  expect(updatedBody).toMatchObject({ id: preset.id, revision: 2, document: doc('Renamed') })

  // Stale revision -> 409, document unchanged.
  const stale = await update(a, preset.id, 1, doc('Stale'))
  expect(stale.status).toBe(409)
  expect((await (await get(a, preset.id)).json()).document).toEqual(doc('Renamed'))

  // Another user cannot update or delete -> 404 (not found, not 403 — no cross-user existence leak).
  expect((await update(b, preset.id, 2, doc('Hijack'))).status).toBe(404)
  expect((await remove(b, preset.id, 2)).status).toBe(404)

  expect((await remove(a, preset.id, 2)).status).toBe(200)
  expect(await (await list(a)).json()).toEqual([])
  expect(await db.select().from(themePresets).where(eq(themePresets.id, preset.id))).toHaveLength(0)
})

test('rejects invalid documents (422) and enforces the per-user cap (409)', async () => {
  expect((await create(a, { ...doc(), base: 'not-a-theme' })).status).toBe(422)
  expect((await create(a, { ...doc(), variants: { light: { '--color-primary': 'url(x)' }, dark: {} } })).status).toBe(
    422
  )
  const ids: string[] = []
  for (let i = 0; i < THEME_PRESET_MAX_PER_USER; i++) {
    const response = await create(a, doc(`Preset ${i}`))
    expect(response.status).toBe(201)
    ids.push((await response.json()).id)
  }
  expect((await create(a, doc('One too many'))).status).toBe(409)
  for (const id of ids) await remove(a, id, 1)
})

test('a non-UUID :id is a 404, never a raw DB error', async () => {
  for (const bad of ['not-a-uuid', '123', 'DROP TABLE theme_presets', '00000000-0000-0000-0000-00000000000z']) {
    expect((await get(a, bad)).status).toBe(404)
    expect((await update(a, bad, 1, doc())).status).toBe(404)
    expect((await remove(a, bad, 1)).status).toBe(404)
  }
})

test('the per-user cap is race-safe: concurrent creates from 49 land exactly 1 more, never over 50', async () => {
  const c = await createTestUser({ prefix })
  const seeded: string[] = []
  for (let i = 0; i < THEME_PRESET_MAX_PER_USER - 1; i++) {
    const response = await create(c, doc(`Seed ${i}`))
    expect(response.status).toBe(201)
    seeded.push((await response.json()).id)
  }
  expect(await db.select().from(themePresets).where(eq(themePresets.ownerUserId, c.id))).toHaveLength(
    THEME_PRESET_MAX_PER_USER - 1
  )
  // Fire several concurrent creates at once (racing the count-then-insert
  // window); without a per-owner lock, more than one could observe the same
  // pre-insert count and all pass the cap check.
  const raceCount = 20
  const responses = await Promise.all(Array.from({ length: raceCount }, (_, i) => create(c, doc(`Race ${i}`))))
  const statuses = responses.map((r) => r.status).sort()
  expect(statuses).toEqual([201, ...Array(raceCount - 1).fill(409)])
  const rows = await db.select().from(themePresets).where(eq(themePresets.ownerUserId, c.id))
  expect(rows).toHaveLength(THEME_PRESET_MAX_PER_USER)
  for (const row of rows) await remove(c, row.id, row.revision)
})

test('body limit rejects an oversized request', async () => {
  const response = await app.request('/theme-presets', {
    method: 'POST',
    headers: { ...authHeaders(a.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: doc(), padding: 'x'.repeat(64000) }),
  })
  expect(response.status).toBe(413)
})

test('user deletion cascades preset rows', async () => {
  const removable = await createTestUser({ prefix })
  await create(removable, doc())
  await db.delete(users).where(eq(users.id, removable.id))
  expect(await db.select().from(themePresets).where(eq(themePresets.ownerUserId, removable.id))).toHaveLength(0)
})
