import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { like } from 'drizzle-orm'
import { db } from '../../db'
import { webhookEvents } from '../../db/schema'
import { storeWebhookEvent, markWebhookProcessed, markWebhookError, getWebhookEvent, listWebhookEvents } from './store'

describe('webhooks/store', () => {
  let testPrefix: string

  beforeEach(async () => {
    testPrefix = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    // Clean up test events by looking for our test prefix in payload
    await db.delete(webhookEvents).where(like(webhookEvents.provider, `${testPrefix}%`))
  })

  describe('storeWebhookEvent', () => {
    it('stores a webhook event and returns its ID', async () => {
      const eventId = await storeWebhookEvent({
        provider: `${testPrefix}-github`,
        eventType: 'push',
        payload: { ref: 'refs/heads/main' },
        headers: { 'x-github-event': 'push' },
        signature: 'sha256=abc123',
        verified: true,
      })

      expect(eventId).toBeDefined()
      expect(typeof eventId).toBe('string')

      const event = await getWebhookEvent(eventId)
      expect(event).not.toBeNull()
      expect(event?.provider).toBe(`${testPrefix}-github`)
      expect(event?.eventType).toBe('push')
      expect(event?.verified).toBe(true)
    })

    it('stores an event with an error', async () => {
      const eventId = await storeWebhookEvent({
        provider: `${testPrefix}-github`,
        eventType: 'push',
        payload: {},
        headers: {},
        signature: 'invalid',
        verified: false,
        error: 'Signature verification failed',
      })

      const event = await getWebhookEvent(eventId)
      expect(event?.verified).toBe(false)
      expect(event?.error).toBe('Signature verification failed')
    })
  })

  describe('markWebhookProcessed', () => {
    it('marks an event as processed', async () => {
      const eventId = await storeWebhookEvent({
        provider: `${testPrefix}-github`,
        eventType: 'push',
        payload: {},
        headers: {},
        signature: null,
        verified: true,
      })

      let event = await getWebhookEvent(eventId)
      expect(event?.processedAt).toBeNull()

      await markWebhookProcessed(eventId)

      event = await getWebhookEvent(eventId)
      expect(event?.processedAt).not.toBeNull()
    })
  })

  describe('markWebhookError', () => {
    it('marks an event as failed with error message', async () => {
      const eventId = await storeWebhookEvent({
        provider: `${testPrefix}-github`,
        eventType: 'push',
        payload: {},
        headers: {},
        signature: null,
        verified: true,
      })

      await markWebhookError(eventId, 'Handler failed: connection timeout')

      const event = await getWebhookEvent(eventId)
      expect(event?.error).toBe('Handler failed: connection timeout')
      expect(event?.processedAt).not.toBeNull()
    })
  })

  describe('getWebhookEvent', () => {
    it('returns null for non-existent event', async () => {
      const event = await getWebhookEvent('00000000-0000-0000-0000-000000000000')
      expect(event).toBeNull()
    })
  })

  describe('listWebhookEvents', () => {
    it('lists events filtered by provider', async () => {
      await storeWebhookEvent({
        provider: `${testPrefix}-github`,
        eventType: 'push',
        payload: {},
        headers: {},
        signature: null,
        verified: true,
      })

      await storeWebhookEvent({
        provider: `${testPrefix}-stripe`,
        eventType: 'payment.completed',
        payload: {},
        headers: {},
        signature: null,
        verified: true,
      })

      const githubEvents = await listWebhookEvents({
        provider: `${testPrefix}-github`,
      })
      expect(githubEvents.length).toBe(1)
      expect(githubEvents[0].eventType).toBe('push')

      const stripeEvents = await listWebhookEvents({
        provider: `${testPrefix}-stripe`,
      })
      expect(stripeEvents.length).toBe(1)
      expect(stripeEvents[0].eventType).toBe('payment.completed')
    })

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await storeWebhookEvent({
          provider: `${testPrefix}-github`,
          eventType: `event-${i}`,
          payload: {},
          headers: {},
          signature: null,
          verified: true,
        })
      }

      const events = await listWebhookEvents({
        provider: `${testPrefix}-github`,
        limit: 3,
      })
      expect(events.length).toBe(3)
    })
  })
})
