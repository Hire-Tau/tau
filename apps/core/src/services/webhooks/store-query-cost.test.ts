import { afterEach, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { webhookEvents } from '../../db/schema'
import { ensureQueryIndex } from '../../test-utils/message-query-indexes'
import { getLastRealWebhookDeliveriesForRepos, latestWebhookDeliveriesSql } from './store'

const provider = `delivery-cost-${crypto.randomUUID()}`
afterEach(async () => {
  await db.delete(webhookEvents).where(eq(webhookEvents.provider, provider))
})

test('latest delivery batches case-insensitive repositories, omits missing/unverified and preserves timestamps', async () => {
  const repositories = Array.from({ length: 501 }, (_, n) => `owner/repo-${n}`)
  await db.insert(webhookEvents).values(
    repositories.map((repository) => ({
      provider,
      eventType: 'test',
      payload: { repository: { full_name: repository.toUpperCase() } },
      headers: {},
      verified: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }))
  )
  await db.insert(webhookEvents).values([
    {
      provider,
      eventType: 'test',
      payload: { repository: { full_name: repositories[0] } },
      headers: {},
      verified: true,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    },
    {
      provider,
      eventType: 'test',
      payload: { repository: { full_name: repositories[0] } },
      headers: {},
      verified: false,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    },
    { provider, eventType: 'test', payload: {}, headers: {}, verified: true },
  ])
  const results = await getLastRealWebhookDeliveriesForRepos(provider, [
    ...repositories,
    repositories[0].toUpperCase(),
    'missing/repo',
  ])
  expect(results.size).toBe(501)
  expect(results.get(repositories[0])?.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  expect(results.get(repositories[500])?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  expect(await getLastRealWebhookDeliveriesForRepos(`${provider}-other`, repositories)).toEqual(new Map())
  expect(await getLastRealWebhookDeliveriesForRepos(provider, [])).toEqual(new Map())
})

test('latest delivery reads the newest index entry instead of every historical webhook', async () => {
  await ensureQueryIndex('idx_webhook_events_verified_repo_delivery')
  await db.execute(sql`INSERT INTO webhook_events(provider,event_type,payload,headers,verified,created_at)
    SELECT ${provider}, 'test', jsonb_build_object('repository', jsonb_build_object('full_name', 'owner/repo')), '{}', true,
      '2026-01-01'::timestamp + n * interval '1 second' FROM generate_series(1,12000) n`)
  await db.execute(sql`ANALYZE webhook_events`)
  const [explained] = await db.execute(
    sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${latestWebhookDeliveriesSql(provider, ['owner/repo'])}`
  )
  const plan = (explained['QUERY PLAN'] as any)[0].Plan
  expect(JSON.stringify(plan)).toContain('idx_webhook_events_verified_repo_delivery')
  expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(100)
  const [oldExplained] = await db.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
    SELECT lower(payload->'repository'->>'full_name'),max(created_at) FROM webhook_events
    WHERE provider=${provider} AND verified=true AND lower(payload->'repository'->>'full_name')='owner/repo'
    GROUP BY lower(payload->'repository'->>'full_name')`)
  const oldPlan = (oldExplained['QUERY PLAN'] as any)[0].Plan
  expect(oldPlan['Shared Hit Blocks'] + oldPlan['Shared Read Blocks']).toBeGreaterThan(100)
})
