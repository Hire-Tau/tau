import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { ttsRouter } from './tts'
import { db } from '../db'
import { messages, agents, agentTypes } from '../db/schema'
import { eq } from 'drizzle-orm'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestUser, type TestUser } from '../test-utils'

function buildApp() {
  const app = new Hono()
  app.use('*', identityMiddleware)
  app.route('/api/tts', ttsRouter)
  return app
}

let admin: TestUser
let unprivileged: TestUser
const rbacPrefix = `tts-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function postJson(app: Hono, body: object) {
  return postJsonWithToken(app, body, admin.token)
}

function postJsonWithToken(app: Hono, body: object, token: string) {
  return app.request('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(body),
  })
}

// Test data
const testAgentTypeId = `tts-test-${Date.now()}`
let testAgentId: string
let humanMessageId: string
let emptyMessageId: string

describe('POST /api/tts', () => {
  const app = buildApp()

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix: rbacPrefix })
    unprivileged = await createTestUser({ prefix: rbacPrefix })
    // Create a test agent type and agent
    await db.insert(agentTypes).values({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'TTS Test Agent',
      systemPrompt: 'Test agent for TTS.',
    })

    const [agent] = await db
      .insert(agents)
      .values({
        agentTypeId: testAgentTypeId,
        context: {},
      })
      .returning()
    testAgentId = agent.id

    // Create test messages
    const [humanMsg] = await db
      .insert(messages)
      .values({
        agentId: testAgentId,
        role: 'human',
        content: 'Hello',
      })
      .returning()
    humanMessageId = humanMsg.id

    await db
      .insert(messages)
      .values({
        agentId: testAgentId,
        role: 'assistant',
        content: 'Hello! How can I help?',
        metadata: {
          content: [{ type: 'text', id: '1', content: 'Hello! How can I help?' }],
        },
      })
      .returning()

    const [emptyMsg] = await db
      .insert(messages)
      .values({
        agentId: testAgentId,
        role: 'assistant',
        content: '',
        metadata: {
          content: [
            {
              type: 'tool_use',
              id: '1',
              toolCall: { toolCallId: 't1', toolName: 'test', args: '{}', result: '{}', isError: false },
            },
          ],
        },
      })
      .returning()
    emptyMessageId = emptyMsg.id
  })

  afterAll(async () => {
    await cleanupTestRbac(rbacPrefix)
    // Clean up test data
    if (testAgentId) {
      await db.delete(messages).where(eq(messages.agentId, testAgentId))
      await db.delete(agents).where(eq(agents.id, testAgentId))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('requires identity and ai:tts permission', async () => {
    const unauthenticated = await app.request('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: humanMessageId }),
    })
    expect(unauthenticated.status).toBe(401)

    const unprivilegedRes = await postJsonWithToken(app, { messageId: humanMessageId }, unprivileged.token)
    expect(unprivilegedRes.status).toBe(403)
  })

  it('returns 400 when messageId is missing', async () => {
    const res = await postJson(app, {})
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('messageId')
  })

  it('returns 400 when messageId is empty', async () => {
    const res = await postJson(app, { messageId: '' })
    expect(res.status).toBe(400)
  })

  it('returns 404 when message does not exist', async () => {
    const res = await postJson(app, { messageId: '00000000-0000-0000-0000-000000000000' })
    expect(res.status).toBe(404)
  })

  it('returns 400 for human messages', async () => {
    const res = await postJson(app, { messageId: humanMessageId })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('assistant')
  })

  it('returns 400 for messages with no text content', async () => {
    const res = await postJson(app, { messageId: emptyMessageId })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('no text')
  })
})
