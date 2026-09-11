import { integrationEnabledPredicate } from '../provider-state'
import { and, eq } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { githubApiGet } from '../../github/api-client'
import { publishIntegrationOutputs } from '../outputs/runtime'
import type { VerifiedIngressEvent } from '../types'

/** A signed tenant webhook proves origin, not which connected account can read its repository. */
export async function publishGitHubWebhookOutputs(event: VerifiedIngressEvent): Promise<string[]> {
  const repository = (event.payload as { repository?: { full_name?: unknown } } | null)?.repository?.full_name
  if (typeof repository !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) return []
  const assignments = await db
    .select({ squadId: integrationConnectionAssignments.squadId, connectionId: integrationConnections.id })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
    .where(
      and(
        eq(integrationConnections.providerKey, 'github'),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate()
      )
    )
  const handled = new Set<string>()
  for (const assignment of assignments) {
    // The API helper rechecks the live assignment and current credential. A PR
    // metadata match alone can never grant an account access to a private repo.
    const access = await githubApiGet<{ full_name: string }>(
      `/repos/${repository}`,
      assignment.squadId,
      assignment.connectionId
    )
    if (!access || access.full_name.toLowerCase() !== repository.toLowerCase()) continue
    for (const squadId of await publishIntegrationOutputs('github', event, { kind: 'connection', ...assignment }))
      handled.add(squadId)
  }
  return [...handled]
}
