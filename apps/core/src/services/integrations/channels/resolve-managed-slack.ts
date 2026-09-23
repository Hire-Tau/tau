import { and, eq, gt, sql } from 'drizzle-orm'
import { db, integrationConnections } from '../../../db'
import { getSecretStore } from '../../secrets'
import { integrationEnabledPredicate } from '../provider-state'
import { parseOAuthCredential } from '../authorization/credential-bundle'
import { channelPlugins, type SlackConfiguration } from './plugins'

/**
 * Privileged, live-from-the-database resolution of the managed ("Add to
 * Slack") connection — mirrors `resolveInstanceGitHubConnection`. Unlike
 * `ChannelConnections`, which serves a periodically refreshed in-memory
 * snapshot to the synchronous chat transports, the hosted relay runner and
 * dispatcher need revision-fenced correctness independent of that refresh
 * cadence: a token rotation or revocation must be visible on the very next
 * read, not after the next snapshot tick.
 *
 * Only ever matches a `platform_broker` row — the manually pasted ("bring
 * your own app") Slack connection is never a relay target, regardless of
 * this instance's current OAuth authority.
 */
export async function resolveManagedSlackConnection(connectionId: string) {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'slack'),
        eq(integrationConnections.adapterVersion, 1),
        eq(integrationConnections.clientAuthority, 'platform_broker'),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        eq(integrationConnections.authState, 'authenticated'),
        eq(integrationConnections.healthState, 'healthy'),
        eq(integrationConnections.validatedRevision, integrationConnections.materialRevision),
        gt(integrationConnections.validationExpiresAt, sql`clock_timestamp()`),
        eq(integrationConnections.id, connectionId)
      )
    )
    .limit(2)
  if (rows.length !== 1) return undefined
  const connection = rows[0]!
  const store = getSecretStore()
  await store.refreshKey(connection.credentialRef)
  const raw = store.get(connection.credentialRef)
  if (!raw) return undefined
  try {
    const credential = parseOAuthCredential(raw)
    return {
      connection,
      configuration: channelPlugins.slack.connection.parseConfiguration(connection.configuration) as SlackConfiguration,
      credential,
    }
  } catch {
    return undefined
  }
}
