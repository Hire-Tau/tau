import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { webhookEvents } from '../../../db/schema'
import { getLastRealWebhookDeliveriesForRepos, storeWebhookEvent } from '../../webhooks/store'
import { GitHubPrWatchPolicy } from './watch-policy'

const provider = `github-test-${crypto.randomUUID()}`

afterEach(async () => {
  await db.delete(webhookEvents).where(eq(webhookEvents.provider, provider))
})

describe('GitHubPrWatchPolicy real-delivery integration', () => {
  test('stops returning a watch after a verified real delivery is recorded', async () => {
    const policy = new GitHubPrWatchPolicy({
      resolveConnection: async (squadId, connectionId) => (connectionId ? undefined : { id: `account-${squadId}` }),
      listWorkStreams: async () => [
        {
          squadId: 's1',
          status: 'active',
          metadata: { github: { repo: 'acme/widgets', pr: { number: 42 } } },
        },
      ],
      lastRealDeliveries: (_ignored, repos) => getLastRealWebhookDeliveriesForRepos(provider, repos),
    })
    expect(await policy.listWatches()).toHaveLength(1)

    await storeWebhookEvent({
      provider,
      eventType: 'issue_comment',
      payload: { repository: { full_name: 'Acme/Widgets' } },
      headers: { 'x-github-event': 'issue_comment' },
      signature: 'sha256=real',
      verified: true,
    })

    expect(await policy.listWatches()).toEqual([])
  })
})
