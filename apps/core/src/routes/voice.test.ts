import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { getSettingsStore } from '../services/settings'
import { voiceSessionRouter } from './voice-session'
import { Hono } from 'hono'
import { createTranscribeRouter } from './transcribe'
import { voiceRouter } from './voice'
import { identityMiddleware } from '../middleware'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'
import { resetSecretStore } from '../services/secrets'

function buildApp() {
  const app = new Hono()
  app.use('/api/*', identityMiddleware)
  app.route('/api/voice', voiceRouter)
  return app
}

async function getStatus(token?: string) {
  return buildApp().request('/api/voice/status', {
    headers: token ? authHeaders(token) : {},
  })
}

const prefix = `voice-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser
let unprivileged: TestUser
const originalKey = process.env.OPENAI_API_KEY

/** The store reads process.env as its fallback source, so drive it from there. */
function setOpenAIKey(value: string | undefined) {
  if (value === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = value
  resetSecretStore()
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  unprivileged = await createTestUser({ prefix })
})

afterEach(() => setOpenAIKey(originalKey))

afterAll(async () => {
  setOpenAIKey(originalKey)
  await cleanupTestRbac(prefix)
})

describe('GET /api/voice/status', () => {
  test('reports enabled when an OpenAI key is configured', async () => {
    setOpenAIKey('sk-test-abcdef123456')

    const res = await getStatus(admin.token)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: true, transcriptionEnabled: true, realtimeEnabled: true })
  })

  test('reports disabled when no OpenAI key is configured', async () => {
    setOpenAIKey(undefined)

    const res = await getStatus(admin.token)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false, transcriptionEnabled: false, realtimeEnabled: false })
  })

  test('treats an empty or whitespace-only key as absent', async () => {
    // A key set to '' would otherwise bring the microphone back and let it fail
    // silently — the exact problem this endpoint exists to prevent.
    setOpenAIKey('')
    expect(await (await getStatus(admin.token)).json()).toEqual({
      enabled: false,
      transcriptionEnabled: false,
      realtimeEnabled: false,
    })

    setOpenAIKey('   \t\n ')
    expect(await (await getStatus(admin.token)).json()).toEqual({
      enabled: false,
      transcriptionEnabled: false,
      realtimeEnabled: false,
    })
  })

  test('never leaks the key, its length, or any prefix of it', async () => {
    setOpenAIKey('sk-super-secret-value')

    const body = await (await getStatus(admin.token)).text()

    expect(body).toBe('{"enabled":true,"transcriptionEnabled":true,"realtimeEnabled":true}')
    expect(body).not.toContain('sk-')
    expect(body).not.toContain('secret')
    expect(Object.keys(JSON.parse(body))).toEqual(['enabled', 'transcriptionEnabled', 'realtimeEnabled'])
  })

  test('requires an identity and a voice-capable permission', async () => {
    setOpenAIKey('sk-test-abcdef123456')

    expect((await getStatus()).status).toBe(401)
    expect((await getStatus(unprivileged.token)).status).toBe(403)
  })

  test('is mounted on the real app', async () => {
    // A router that is written but never wired into index.ts typechecks fine and
    // passes every test above, while the client silently 404s in production.
    const { app } = await import('../index')

    expect(app.routes.some((route) => route.method === 'GET' && route.path === '/api/voice/status')).toBe(true)
  })
})

test('realtime can be disabled without disabling transcription, and sessions are rejected', async () => {
  setOpenAIKey('sk-test-feature-control')
  const store = getSettingsStore()
  const previous = store.getStoredValue('ASSISTANT_REALTIME_ENABLED')
  try {
    await store.set('ASSISTANT_REALTIME_ENABLED', 'false')
    expect(await (await getStatus(admin.token)).json()).toEqual({
      enabled: true,
      transcriptionEnabled: true,
      realtimeEnabled: false,
    })
    const app = new Hono()
    app.use('*', identityMiddleware)
    app.route('/api/voice-session', voiceSessionRouter)
    const response = await app.request('/api/voice-session', { method: 'POST', headers: authHeaders(admin.token) })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Realtime assistant is disabled in Settings → Assistant & Memory.' })
  } finally {
    if (previous === undefined) await store.delete('ASSISTANT_REALTIME_ENABLED')
    else await store.set('ASSISTANT_REALTIME_ENABLED', previous)
  }
})

test('disabled dictation rejects uploads before reading audio or calling the provider, independently of realtime', async () => {
  setOpenAIKey('sk-test-feature-control')
  const store = getSettingsStore()
  const previous = store.getStoredValue('TRANSCRIPTION_ENABLED')
  let calls = 0
  const app = new Hono().use('*', identityMiddleware)
  app.route(
    '/api/transcribe',
    createTranscribeRouter(async () => {
      calls++
      return { text: 'hello' }
    })
  )
  try {
    await store.set('TRANSCRIPTION_ENABLED', 'false')
    expect(await (await getStatus(admin.token)).json()).toEqual({
      enabled: true,
      transcriptionEnabled: false,
      realtimeEnabled: true,
    })
    const response = await app.request('/api/transcribe', { method: 'POST', headers: authHeaders(admin.token) })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Voice dictation is disabled in Settings → Assistant & Memory.' })
    expect(calls).toBe(0)
    expect(
      (await app.request('/api/transcribe', { method: 'POST', headers: authHeaders(unprivileged.token) })).status
    ).toBe(403)
    await store.set('TRANSCRIPTION_ENABLED', 'true')
    const form = new FormData()
    form.append('audio', new File(['audio'], 'voice.webm', { type: 'audio/webm' }))
    const enabled = await app.request('/api/transcribe', {
      method: 'POST',
      headers: authHeaders(admin.token),
      body: form,
    })
    expect(enabled.status).toBe(200)
    expect(calls).toBe(1)
  } finally {
    if (previous === undefined) await store.delete('TRANSCRIPTION_ENABLED')
    else await store.set('TRANSCRIPTION_ENABLED', previous)
  }
})
