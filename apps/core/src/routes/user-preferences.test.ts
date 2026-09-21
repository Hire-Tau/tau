import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { userPreferencesRouter } from './user-preferences'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { authHeaders, cleanupTestRbac, createTestUser, type TestUser } from '../test-utils'
import { db, userPreferences, users } from '../db'

const prefix = `theme-prefs-${crypto.randomUUID()}`
let a: TestUser
let b: TestUser
const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/user-preferences', userPreferencesRouter)
const theme = { themeId: 'harbor', appearance: 'dark', customTheme: null }
const customTheme = {
  format: 'tau-custom-theme',
  version: 1,
  name: 'Synced',
  base: 'harbor',
  appearance: 'dark',
  overrides: { '--term-bg': '#12345680' },
}
const get = (user: TestUser) => app.request('/user-preferences/me', { headers: authHeaders(user.token) })
const put = (user: TestUser, body: unknown) =>
  app.request('/user-preferences/me', {
    method: 'PUT',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
beforeAll(async () => {
  a = await createTestUser({ prefix })
  b = await createTestUser({ prefix })
})
afterAll(async () => {
  await cleanupTestRbac(prefix)
})

test('anonymous access cannot read or mutate a preference', async () => {
  for (const method of ['GET', 'PUT']) expect((await app.request('/user-preferences/me', { method })).status).toBe(401)
})
test('no account choice is null; unprivileged callers self-serve isolated atomic theme/custom preferences', async () => {
  const first = await get(a)
  expect(first.status).toBe(200)
  expect(await first.json()).toEqual({ userId: a.id, theme: null })
  expect((await put(a, { expectedUserId: a.id, theme: { ...theme, customTheme } })).status).toBe(200)
  expect(await (await get(a)).json()).toEqual({ userId: a.id, theme: { ...theme, customTheme } })
  expect(await (await get(b)).json()).toEqual({ userId: b.id, theme: null })
  expect((await put(a, { expectedUserId: a.id, theme })).status).toBe(200)
  expect(await (await get(a)).json()).toEqual({ userId: a.id, theme })
  expect(await db.select().from(userPreferences).where(eq(userPreferences.userId, a.id))).toHaveLength(1)
})
test('identity precondition rejects queued writes sent with a different account session', async () => {
  expect((await put(b, { expectedUserId: a.id, theme })).status).toBe(409)
  expect((await put(b, { theme })).status).toBe(409)
  expect(await (await get(b)).json()).toEqual({ userId: b.id, theme: null })
})
test('rejects malformed, unsafe, incoherent and oversized documents without changing existing preference', async () => {
  const before = await (await get(a)).json()
  const malformed = await app.request('/user-preferences/me', {
    method: 'PUT',
    headers: authHeaders(a.token),
    body: '{',
  })
  expect(malformed.status).toBe(400)
  for (const invalid of [
    {},
    { ...theme, themeId: 'unknown' },
    { ...theme, appearance: 'constant' },
    { ...theme, customTheme: { ...customTheme, overrides: { '--term-bg': 'url(x)' } } },
    { ...theme, customTheme: { ...customTheme, base: 'ember' } },
    { ...theme, customTheme: { ...customTheme, extra: 'x'.repeat(8200) } },
  ]) {
    expect((await put(a, { expectedUserId: a.id, theme: invalid })).status).toBe(400)
  }
  expect((await put(a, { expectedUserId: a.id, theme, padding: 'x'.repeat(10000) })).status).toBe(413)
  expect(await (await get(a)).json()).toEqual(before)
})
test('user deletion cascades the preference row', async () => {
  const removable = await createTestUser({ prefix })
  await put(removable, { expectedUserId: removable.id, theme })
  await db.delete(users).where(eq(users.id, removable.id))
  expect(await db.select().from(userPreferences).where(eq(userPreferences.userId, removable.id))).toHaveLength(0)
})
