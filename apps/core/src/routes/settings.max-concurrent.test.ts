import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware/identity'
import settingsRouter from './settings'
import { getSettingsStore } from '../services/settings'
import { MAX_CONCURRENT_AGENTS_SETTING_KEY, MAX_MAX_CONCURRENT_AGENTS } from '../services/execution/max-concurrent'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/settings', settingsRouter)

const prefix = `settings-cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
})

beforeEach(async () => {
  await getSettingsStore().initialize()
  await getSettingsStore().delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
})

afterEach(async () => {
  await getSettingsStore().delete(MAX_CONCURRENT_AGENTS_SETTING_KEY)
})

async function put(value: string): Promise<Response> {
  return putRaw({ value })
}

/** PUT an arbitrary JSON body, so non-string `value` types can be exercised. */
async function putRaw(body: unknown, key = MAX_CONCURRENT_AGENTS_SETTING_KEY): Promise<Response> {
  return app.request(`/api/settings/${key}`, {
    method: 'PUT',
    headers: { ...authHeaders(admin.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PUT /settings/MAX_CONCURRENT_AGENTS', () => {
  test('accepts a valid cap and persists it', async () => {
    const res = await put('12')
    expect(res.status).toBe(200)
    expect(getSettingsStore().getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBe('12')
  })

  // Mutation caught: letting SettingValidationError escape as an unhandled 500
  // (opaque to the operator), or — worse — not validating at the route at all
  // so an out-of-range cap is persisted with a 200.
  test.each([
    ['zero', '0'],
    ['negative', '-3'],
    ['non-numeric', 'lots'],
    ['absurdly large', String(MAX_MAX_CONCURRENT_AGENTS + 1)],
  ])('rejects %s with 400 and a message naming the range', async (_label, badValue) => {
    const res = await put(badValue)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('MAX_CONCURRENT_AGENTS')
    expect(body.error).toContain(`between 1 and ${MAX_MAX_CONCURRENT_AGENTS}`)
    // Nothing was written.
    expect(getSettingsStore().getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBeUndefined()
  })

  test('a rejected write leaves a previously stored cap intact', async () => {
    expect((await put('15')).status).toBe(200)
    expect((await put('0')).status).toBe(400)
    expect(getSettingsStore().getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBe('15')
  })

  /**
   * A JSON number is the obvious thing for a client to send to a setting whose
   * declared type is `number`, and the store's validators are written against
   * strings — `value.trim()` on a number throws, which surfaced as a 500 on a
   * perfectly well-formed request. The route must reject the TYPE before the
   * value reaches any validator.
   */
  test.each([
    ['null', null],
    ['an array', []],
    ['a string primitive', 'value'],
    ['a number primitive', 12],
    ['a boolean primitive', true],
    ['an object missing value', {}],
  ])('rejects %s request body as missing value', async (_label, badBody) => {
    const res = await putRaw(badBody)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing "value" in request body' })
    expect(getSettingsStore().getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBeUndefined()
  })

  test.each([
    ['a JSON number', 12],
    ['a JSON boolean', true],
    ['a JSON null', null],
    ['a JSON array', ['12']],
    ['a JSON object', { n: 12 }],
  ])('rejects %s value with 400, not 500', async (_label, badBody) => {
    const res = await putRaw({ value: badBody })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('value')
    expect(body.error).toContain('string')
    expect(getSettingsStore().getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBeUndefined()
  })

  // Mutation caught: a typeof guard so eager it also rejects the empty string,
  // which is a legitimate value for the free-form string settings on this route.
  test('a non-string value is rejected on any key, and an empty string still is not', async () => {
    expect((await putRaw({ value: 5 }, 'LOCAL_AUTO_UPDATE_REMOTE')).status).toBe(400)
    const ok = await putRaw({ value: '' }, 'LOCAL_AUTO_UPDATE_REMOTE')
    expect(ok.status).toBe(200)
    await getSettingsStore().delete('LOCAL_AUTO_UPDATE_REMOTE')
  })

  test('DELETE reverts to the default', async () => {
    expect((await put('15')).status).toBe(200)
    const res = await app.request(`/api/settings/${MAX_CONCURRENT_AGENTS_SETTING_KEY}`, {
      method: 'DELETE',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    expect(getSettingsStore().getStoredValue(MAX_CONCURRENT_AGENTS_SETTING_KEY)).toBeUndefined()
  })
})
