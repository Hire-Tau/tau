/**
 * Linear Webhook Processor Tests
 *
 * Tests for Linear webhook signature verification, event type extraction,
 * and issue assignment handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createHmac } from 'crypto'
import { linearProcessor, handleLinearIssueUpdate, setLinearActionConfig } from './linear'
import type { WebhookContext } from '../types'

describe('linearProcessor', () => {
  describe('verifySignature', () => {
    const secret = 'test-secret-key'

    it('returns true for valid signature', async () => {
      const rawBody = '{"action":"update","type":"Issue"}'
      // Compute correct HMAC-SHA256 signature (Linear sends raw hex, no prefix)
      const validSignature = createHmac('sha256', secret).update(rawBody).digest('hex')

      const ctx: WebhookContext = {
        provider: 'linear',
        eventType: 'Issue',
        payload: { action: 'update', type: 'Issue' },
        headers: { 'linear-signature': validSignature },
        rawBody,
      }

      const result = await linearProcessor.verifySignature(ctx, secret)
      expect(result).toBe(true)
    })

    it('returns false for invalid signature', async () => {
      const ctx: WebhookContext = {
        provider: 'linear',
        eventType: 'Issue',
        payload: {},
        headers: { 'linear-signature': 'invalid-not-hex-signature' },
        rawBody: '{}',
      }

      const result = await linearProcessor.verifySignature(ctx, secret)
      expect(result).toBe(false)
    })

    it('returns false for wrong signature', async () => {
      const rawBody = '{"action":"update"}'
      // Compute signature with wrong secret
      const wrongSignature = createHmac('sha256', 'wrong-secret').update(rawBody).digest('hex')

      const ctx: WebhookContext = {
        provider: 'linear',
        eventType: 'Issue',
        payload: {},
        headers: { 'linear-signature': wrongSignature },
        rawBody,
      }

      const result = await linearProcessor.verifySignature(ctx, secret)
      expect(result).toBe(false)
    })

    it('returns false for missing signature', async () => {
      const ctx: WebhookContext = {
        provider: 'linear',
        eventType: 'Issue',
        payload: {},
        headers: {},
        rawBody: '{}',
      }

      const result = await linearProcessor.verifySignature(ctx, secret)
      expect(result).toBe(false)
    })
  })

  describe('getEventType', () => {
    it('extracts event type from Linear-Event header', () => {
      const ctx: WebhookContext = {
        provider: 'linear',
        eventType: '',
        payload: {},
        headers: { 'linear-event': 'Issue' },
        rawBody: '{}',
      }

      expect(linearProcessor.getEventType(ctx)).toBe('Issue')
    })

    it('handles Comment event type', () => {
      const ctx: WebhookContext = {
        provider: 'linear',
        eventType: '',
        payload: {},
        headers: { 'linear-event': 'Comment' },
        rawBody: '{}',
      }

      expect(linearProcessor.getEventType(ctx)).toBe('Comment')
    })

    it('returns unknown for missing header', () => {
      const ctx: WebhookContext = {
        provider: 'linear',
        eventType: '',
        payload: {},
        headers: {},
        rawBody: '{}',
      }

      expect(linearProcessor.getEventType(ctx)).toBe('unknown')
    })
  })

  describe('getSecret', () => {
    const originalSecret = process.env.LINEAR_WEBHOOK_SECRET

    afterEach(() => {
      if (originalSecret) {
        process.env.LINEAR_WEBHOOK_SECRET = originalSecret
      } else {
        delete process.env.LINEAR_WEBHOOK_SECRET
      }
    })

    it('does not read the retired environment secret outside integration settings', () => {
      process.env.LINEAR_WEBHOOK_SECRET = 'my-test-secret'

      expect(linearProcessor.getSecret()).toBeNull()
    })

    it('returns null when not configured', () => {
      delete process.env.LINEAR_WEBHOOK_SECRET

      expect(linearProcessor.getSecret()).toBeNull()
    })
  })
})

describe('handleLinearIssueUpdate', () => {
  const originalUserId = process.env.LINEAR_USER_ID

  beforeEach(() => {
    process.env.LINEAR_USER_ID = 'target-user-id-uuid'
    // Clear action config by setting to empty config
    setLinearActionConfig({})
  })

  afterEach(() => {
    if (originalUserId) {
      process.env.LINEAR_USER_ID = originalUserId
    } else {
      delete process.env.LINEAR_USER_ID
    }
  })

  it('ignores non-update actions', async () => {
    const ctx: WebhookContext = {
      provider: 'linear',
      eventType: 'Issue',
      payload: { action: 'create', type: 'Issue', data: {} },
      headers: {},
      rawBody: '{}',
    }

    // Should not throw, just return early
    await expect(handleLinearIssueUpdate(ctx)).resolves.toBeUndefined()
  })

  it('ignores updates without assignee change', async () => {
    const ctx: WebhookContext = {
      provider: 'linear',
      eventType: 'Issue',
      payload: {
        action: 'update',
        type: 'Issue',
        data: { assigneeId: 'target-user-id-uuid' },
        updatedFrom: { title: 'old title' }, // No assigneeId in updatedFrom
      },
      headers: {},
      rawBody: '{}',
    }

    await expect(handleLinearIssueUpdate(ctx)).resolves.toBeUndefined()
  })

  it('ignores assignments to other users', async () => {
    const ctx: WebhookContext = {
      provider: 'linear',
      eventType: 'Issue',
      payload: {
        action: 'update',
        type: 'Issue',
        data: { assigneeId: 'other-user-id' },
        updatedFrom: { assigneeId: 'previous-user-id' },
      },
      headers: {},
      rawBody: '{}',
    }

    await expect(handleLinearIssueUpdate(ctx)).resolves.toBeUndefined()
  })

  it('ignores when LINEAR_USER_ID is not configured', async () => {
    delete process.env.LINEAR_USER_ID

    const ctx: WebhookContext = {
      provider: 'linear',
      eventType: 'Issue',
      payload: {
        action: 'update',
        type: 'Issue',
        data: { assigneeId: 'some-user' },
        updatedFrom: { assigneeId: 'old-user' },
      },
      headers: {},
      rawBody: '{}',
    }

    await expect(handleLinearIssueUpdate(ctx)).resolves.toBeUndefined()
  })

  it('logs when action config is not loaded but assignment matches', async () => {
    const ctx: WebhookContext = {
      provider: 'linear',
      eventType: 'Issue',
      payload: {
        action: 'update',
        type: 'Issue',
        data: {
          id: 'issue-uuid',
          number: 123,
          title: 'Test Issue',
          assigneeId: 'target-user-id-uuid',
        },
        updatedFrom: { assigneeId: 'old-user-uuid' },
      },
      headers: {},
      rawBody: '{}',
    }

    // Should not throw, just log warning and return
    await expect(handleLinearIssueUpdate(ctx)).resolves.toBeUndefined()
  })
})
