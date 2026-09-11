import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { afterEach, describe, expect, test } from 'bun:test'
import { dispatchVerifiedWebhookEvent } from './dispatch'
import { webhookRegistry } from './registry'

afterEach(() => webhookRegistry.clear())

describe('dispatchVerifiedWebhookEvent', () => {
  test('uses the same specific and wildcard registry handler path for synthetic events', async () => {
    const received: unknown[] = []
    webhookRegistry.registerHandler('github', 'issue_comment', async (ctx) => {
      received.push(ctx)
    })
    webhookRegistry.registerHandler('github', '*', async (ctx) => {
      received.push(ctx)
    })

    await dispatchVerifiedWebhookEvent('github', {
      type: 'issue_comment',
      payload: { action: 'created' },
      metadata: { synthetic: true },
    })

    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({
      provider: 'github',
      eventType: 'issue_comment',
      payload: { action: 'created' },
      metadata: { synthetic: true },
    })
  })

  test('runs every handler and reports their errors together', async () => {
    let finalHandlerRan = false
    webhookRegistry.registerHandler('github', 'pull_request', async () => {
      throw new Error('first')
    })
    webhookRegistry.registerHandler('github', 'pull_request', async () => {
      finalHandlerRan = true
      throw new Error('second')
    })

    await expect(dispatchVerifiedWebhookEvent('github', { type: 'pull_request', payload: {} })).rejects.toThrow(
      'first; second'
    )
    expect(finalHandlerRan).toBe(true)
  })
})
