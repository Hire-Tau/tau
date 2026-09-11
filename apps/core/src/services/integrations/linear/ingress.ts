import { and, eq } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections } from '../../../db'
import { integrationEnabledPredicate } from '../provider-state'
import { publishIntegrationOutputs } from '../outputs/runtime'
import type { VerifiedIngressEvent } from '../types'
import { linearOutputAdapter } from './outputs'
import { linearQuery } from './plugin'
import { resolveLinearConnection } from './resolve-connection'

export interface LinearAssignmentAccess {
  viewer: { id: string }
  issue: { id: string; team: { id: string }; assignee: { id: string } | null } | null
}
export function canReceiveLinearAssignment(
  access: LinearAssignmentAccess,
  issue: { id: string; teamId: string; assigneeId: string }
) {
  return (
    access.viewer.id === issue.assigneeId &&
    access.issue?.id === issue.id &&
    access.issue.team.id === issue.teamId &&
    access.issue.assignee?.id === issue.assigneeId
  )
}

/** A valid signature proves origin; each connected account must also be able to read the issue. */
export async function routeLinearAssignment(event: VerifiedIngressEvent, fallback: (squadId: string) => Promise<void>) {
  if (!linearOutputAdapter.normalize(event).length) return
  const issue = (event.payload as { data: { id: string; teamId: string; assigneeId: string } }).data
  const assignments = await db
    .select({ squadId: integrationConnectionAssignments.squadId })
    .from(integrationConnectionAssignments)
    .innerJoin(integrationConnections, eq(integrationConnections.id, integrationConnectionAssignments.connectionId))
    .where(
      and(
        eq(integrationConnections.providerKey, 'linear'),
        integrationEnabledPredicate(),
        eq(integrationConnections.enabled, true)
      )
    )
  for (const { squadId } of assignments) {
    const resolved = await resolveLinearConnection(squadId)
    if (!resolved) continue
    let access: LinearAssignmentAccess
    try {
      access = await linearQuery<LinearAssignmentAccess>(
        resolved.credential,
        'query AssignmentAccess($id: String!) { viewer { id } issue(id: $id) { id team { id } assignee { id } } }',
        { id: issue.id }
      )
    } catch {
      continue
    }
    if (!canReceiveLinearAssignment(access, issue)) continue
    const handled = await publishIntegrationOutputs('linear', event, {
      kind: 'connection',
      squadId,
      connectionId: resolved.connection.id,
      connectionRevision: resolved.connection.materialRevision,
    })
    if (!handled.includes(squadId)) await fallback(squadId)
  }
}
