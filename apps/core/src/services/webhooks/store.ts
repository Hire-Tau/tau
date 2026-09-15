/**
 * Webhook Event Store - Persistence for webhook events
 *
 * Stores webhook events for debugging and audit purposes.
 */

import { db } from '../../db'
import { squadSourceConfigs, webhookEvents, workStreams } from '../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { extractGitHubIssueDispatchFact } from '../squad-activity/github-issue-fact'
import { extractGitHubPrDispatchFact } from '../squad-activity/github-pr-fact'
import type { StoreWebhookEventInput, WebhookEvent } from './types'

/**
 * Store a webhook event in the database
 * @returns The ID of the created event
 */
export async function storeWebhookEvent(input: StoreWebhookEventInput): Promise<string> {
  const ingress = {
    type: input.eventType,
    payload: input.payload,
    metadata: { providerDeliveryId: input.headers['x-github-delivery'] },
  }
  // Ownership only needs the delivering repository, which both GitHub receipt
  // families carry; the two extractors are mutually exclusive, so at most one
  // fact exists per delivery.
  const fact =
    input.verified && input.provider === 'github'
      ? (extractGitHubPrDispatchFact('github', ingress) ?? extractGitHubIssueDispatchFact('github', ingress))
      : null
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
    // A squad owns interest in a repo's PR/issue events through EITHER claim:
    // an enabled github_issue source config scoped to the repo, OR any work
    // stream that names the repo — legacy `github.repo`, canonical
    // `codeHost.repository`, or a `tracked` entry. The second clause is what
    // makes GitHub activity rows appear for ordinary PR-workflow squads —
    // without it, only issue-intake squads ever saw GitHub activity (observed
    // live: 6.6k stored webhook events, zero with a squad association).
    const owners = fact
      ? await tx
          .selectDistinct({ squadId: squadSourceConfigs.squadId })
          .from(squadSourceConfigs)
          .where(
            sql`${squadSourceConfigs.sourceType}='github_issue' AND ${squadSourceConfigs.enabled}=true
              AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE
                WHEN jsonb_typeof(${squadSourceConfigs.policy}->'scope'->'repos')='array'
                  THEN ${squadSourceConfigs.policy}->'scope'->'repos' ELSE '[]'::jsonb END) configured(repo)
                WHERE lower(configured.repo)=lower(${fact.repository}))`
          )
          .union(
            tx
              .selectDistinct({ squadId: workStreams.squadId })
              .from(workStreams)
              .where(
                sql`lower(btrim(${workStreams.metadata}->'github'->>'repo'))=lower(${fact.repository})
                  OR lower(btrim(${workStreams.metadata}->'codeHost'->>'repository'))=lower(${fact.repository})
                  OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE
                    WHEN jsonb_typeof(${workStreams.metadata}->'tracked')='array'
                      THEN ${workStreams.metadata}->'tracked' ELSE '[]'::jsonb END) t
                    WHERE lower(btrim(t->>'repository'))=lower(${fact.repository}))`
              )
          )
      : []
    const [result] = await tx
      .insert(webhookEvents)
      .values({
        provider: input.provider,
        eventType: input.eventType,
        payload: input.payload,
        headers: input.headers,
        signature: input.signature,
        verified: input.verified,
        activitySquadIds: owners.map((owner) => owner.squadId),
        error: input.error ?? null,
      })
      .returning({ id: webhookEvents.id })
    return result.id
  })
}

/**
 * Mark a webhook event as successfully processed
 */
export async function markWebhookProcessed(eventId: string): Promise<void> {
  await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, eventId))
}

/**
 * Mark a webhook event as failed with an error message
 */
export async function markWebhookError(eventId: string, error: string): Promise<void> {
  await db.update(webhookEvents).set({ error, processedAt: new Date() }).where(eq(webhookEvents.id, eventId))
}

/**
 * Get a webhook event by ID
 */
export async function getWebhookEvent(eventId: string): Promise<WebhookEvent | null> {
  const [result] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventId))

  if (!result) return null

  return {
    id: result.id,
    provider: result.provider,
    eventType: result.eventType,
    payload: result.payload as Record<string, unknown>,
    headers: result.headers as Record<string, string>,
    signature: result.signature,
    verified: result.verified,
    processedAt: result.processedAt,
    error: result.error,
    createdAt: result.createdAt,
  }
}

/** Latest verified real deliveries, batched and keyed by lowercase repository name. */
export async function getLastRealWebhookDeliveriesForRepos(
  provider: string,
  repos: readonly string[]
): Promise<Map<string, Date>> {
  const normalized = [...new Set(repos.map((repo) => repo.toLowerCase()))]
  const deliveries = new Map<string, Date>()
  for (let offset = 0; offset < normalized.length; offset += 500) {
    const chunk = normalized.slice(offset, offset + 500)
    const results = await db.execute<{ repository: string; delivered_at: string }>(
      latestWebhookDeliveriesSql(provider, chunk)
    )
    for (const result of results) deliveries.set(result.repository, new Date(result.delivered_at))
  }
  return deliveries
}

/** One bounded index lookup per repository, including for repositories with long delivery histories. */
export function latestWebhookDeliveriesSql(provider: string, repositories: readonly string[]) {
  return sql`
    SELECT requested.repository, latest.created_at AS delivered_at
    FROM unnest(ARRAY[${sql.join(
      repositories.map((repository) => sql`${repository}`),
      sql`, `
    )}]::text[]) AS requested(repository)
    CROSS JOIN LATERAL (
      SELECT ${webhookEvents.createdAt}
      FROM ${webhookEvents}
      WHERE ${webhookEvents.provider} = ${provider}
        AND ${webhookEvents.verified} = true
        AND (${webhookEvents.payload}->'repository'->>'full_name') IS NOT NULL
        AND lower(${webhookEvents.payload}->'repository'->>'full_name') = requested.repository
      ORDER BY ${webhookEvents.createdAt} DESC NULLS LAST
      LIMIT 1
    ) latest
  `
}

/** Compatibility wrapper for callers that need one repository. */
export async function getLastRealWebhookDeliveryForRepo(provider: string, repo: string): Promise<Date | null> {
  return (await getLastRealWebhookDeliveriesForRepos(provider, [repo])).get(repo.toLowerCase()) ?? null
}

/** List recent webhook events, optionally filtered by provider. */
export async function listWebhookEvents(options?: { provider?: string; limit?: number }): Promise<WebhookEvent[]> {
  const limit = options?.limit ?? 50

  let query = db.select().from(webhookEvents).orderBy(webhookEvents.createdAt).limit(limit)

  if (options?.provider) {
    query = query.where(eq(webhookEvents.provider, options.provider)) as typeof query
  }

  const results = await query

  return results.map((result) => ({
    id: result.id,
    provider: result.provider,
    eventType: result.eventType,
    payload: result.payload as Record<string, unknown>,
    headers: result.headers as Record<string, string>,
    signature: result.signature,
    verified: result.verified,
    processedAt: result.processedAt,
    error: result.error,
    createdAt: result.createdAt,
  }))
}
