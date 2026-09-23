import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createHmac } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { webhooksRouter } from './webhooks'
import { slackProvider } from '../channels/slack'
import { ChannelInstance } from '../entities/ChannelInstance'
import * as settings from '../services/integrations/channels/settings'
import { db, integrationEventPollingDispatches } from '../db'

// Exercises the real signature verification, parser and handler; only the
// channel-instance lookup and the Slack bot-identity call are replaced, the
// same boundary `webhooks.telegram.test.ts` uses for Telegram.
const app = new Hono().route('/webhooks', webhooksRouter)
const SIGNING_SECRET = 'fixture-signing-secret'
const TEAM_ID = 'T12345678'

let credentials: Record<string, string>
let getSetting: ReturnType<typeof spyOn<typeof settings, 'getChannelIntegrationValue'>>
let findInstance: ReturnType<typeof spyOn<typeof ChannelInstance, 'findByProvider'>>
let botId: ReturnType<typeof spyOn<typeof slackProvider, 'getBotUserId'>>

beforeEach(() => {
  // No SLACK_BOT_TOKEN: `hasToken()` stays false, so the parser's optional
  // user-label/permalink lookups take their no-network fallback instead of
  // calling the real Slack API.
  credentials = { SLACK_SIGNING_SECRET: SIGNING_SECRET }
  getSetting = spyOn(settings, 'getChannelIntegrationValue').mockImplementation((key) => credentials[key])
  findInstance = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(null)
  botId = spyOn(slackProvider, 'getBotUserId').mockResolvedValue('BOTUSER1')
})
afterEach(() => {
  getSetting.mockRestore()
  findInstance.mockRestore()
  botId.mockRestore()
})

function sign(rawBody: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = 'v0=' + createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex')
  return { 'x-slack-signature': signature, 'x-slack-request-timestamp': timestamp }
}

function eventCallback(eventId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    team_id: TEAM_ID,
    event_id: eventId,
    event: { type: 'app_mention', text: 'hi', user: 'U1', channel: 'C1', ts: '100.1' },
    ...extra,
  }
}

function post(payload: unknown, headers: Record<string, string> = {}) {
  const rawBody = JSON.stringify(payload)
  return app.request('/webhooks/channels/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sign(rawBody), ...headers },
    body: rawBody,
  })
}

describe('Slack direct webhook event_callback dedup', () => {
  it('handles a retried delivery (same event_id) exactly once', async () => {
    const eventId = `Ev${crypto.randomUUID()}`
    const first = await post(eventCallback(eventId))
    expect(first.status).toBe(200)
    expect(findInstance).toHaveBeenCalledTimes(1)

    // Slack retries with the same event_id and marks it with retry headers.
    const retry = await post(eventCallback(eventId), { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'timeout' })
    expect(retry.status).toBe(200)
    expect(findInstance).toHaveBeenCalledTimes(1)
  })

  it('processes a different event_id from the same team independently', async () => {
    await post(eventCallback(`Ev${crypto.randomUUID()}`))
    expect(findInstance).toHaveBeenCalledTimes(1)
    await post(eventCallback(`Ev${crypto.randomUUID()}`))
    expect(findInstance).toHaveBeenCalledTimes(2)
  })

  it('processes the same event_id independently for a different team', async () => {
    const eventId = `Ev${crypto.randomUUID()}`
    await post(eventCallback(eventId))
    expect(findInstance).toHaveBeenCalledTimes(1)
    await post(eventCallback(eventId, { team_id: 'T99999999' }))
    expect(findInstance).toHaveBeenCalledTimes(2)
  })

  it('releases the receipt on a handler failure, so a retry with the same event_id is processed (not lost forever)', async () => {
    const eventId = `Ev${crypto.randomUUID()}`
    findInstance.mockRejectedValueOnce(new Error('transient handler failure'))
    const first = await post(eventCallback(eventId))
    expect(first.status).toBe(500)
    expect(findInstance).toHaveBeenCalledTimes(1)

    // Slack retries after the 500. If the claim was never released, this retry
    // would see the claim as still `busy` (120s lease) and the event would be
    // dropped with a 200 that never actually redelivered it.
    const retry = await post(eventCallback(eventId), { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'timeout' })
    expect(retry.status).toBe(200)
    expect(findInstance).toHaveBeenCalledTimes(2)
  })

  it('never claims a durable receipt for a non-actionable event (nothing for the bot to act on)', async () => {
    const eventId = `Ev${crypto.randomUUID()}`
    // A plain channel message, not a mention/DM/thread reply: `parseWebhook`
    // returns null for it — there is no handler work to dedup in the first
    // place, so the claim must never be taken (and the row must never exist).
    const payload = {
      type: 'event_callback',
      team_id: TEAM_ID,
      event_id: eventId,
      event: { type: 'message', channel_type: 'channel', channel: 'C1', text: 'unrelated chatter', user: 'U1', ts: '100.1' },
    }
    const res = await post(payload)
    expect(res.status).toBe(200)
    expect(findInstance).not.toHaveBeenCalled()

    const rows = await db
      .select({ eventKey: integrationEventPollingDispatches.eventKey })
      .from(integrationEventPollingDispatches)
      .where(
        and(
          eq(integrationEventPollingDispatches.providerKey, 'slack'),
          eq(integrationEventPollingDispatches.eventKey, `webhook:${TEAM_ID}:${eventId}`)
        )
      )
    expect(rows).toHaveLength(0)
  })

  it('does not dedup slash commands (Slack never retries them)', async () => {
    const rawBody = new URLSearchParams({
      command: '/tau',
      text: 'ask hi',
      team_id: TEAM_ID,
      channel_id: 'C1',
      user_id: 'U1',
      user_name: 'tester',
      response_url: 'https://hooks.slack.com/commands/T1/1/abc',
      trigger_id: 'trigger-1',
    }).toString()
    const headers = { 'content-type': 'application/x-www-form-urlencoded', ...sign(rawBody) }
    const first = await app.request('/webhooks/channels/slack', { method: 'POST', headers, body: rawBody })
    expect(first.status).toBe(200)
    const second = await app.request('/webhooks/channels/slack', { method: 'POST', headers, body: rawBody })
    expect(second.status).toBe(200)
    expect(findInstance).toHaveBeenCalledTimes(2)
  })
})
