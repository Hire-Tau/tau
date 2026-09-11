import { isIntegrationEnabled } from '../provider-state'
import { and, eq } from 'drizzle-orm'
import {
  db,
  agents,
  agentTypes,
  integrationConnectionAssignments,
  integrationConnections,
  integrationExportBatches,
  integrationExportConsents,
  integrationExportCursors,
} from '../../../db'
import type { ExportBatchRecord } from './outbox'
import { bigbrainPlugin } from '../bigbrain/plugin'

export function isSupportedExportDeliveryState(state: {
  connection: { providerKey: string; adapterVersion: number; configuration: unknown }
  consent: { policyVersion: number; projectionVersion: number }
}): boolean {
  if (
    state.connection.providerKey !== 'bigbrain' ||
    state.connection.adapterVersion !== 1 ||
    state.consent.policyVersion !== 1 ||
    state.consent.projectionVersion !== 1
  )
    return false
  try {
    bigbrainPlugin.connection.parseConfiguration(state.connection.configuration)
    return true
  } catch {
    return false
  }
}

export async function resolveExportDeliveryDecision(batch: ExportBatchRecord) {
  const [row] = await db
    .select({
      connection: integrationConnections,
      consent: integrationExportConsents,
      agent: agents,
      policy: agentTypes.integrationCapabilities,
      assignmentConnectionId: integrationConnectionAssignments.connectionId,
    })
    .from(integrationExportBatches)
    .innerJoin(integrationExportCursors, eq(integrationExportCursors.id, integrationExportBatches.cursorId))
    .innerJoin(integrationExportConsents, eq(integrationExportConsents.id, integrationExportCursors.consentId))
    .innerJoin(integrationConnections, eq(integrationConnections.id, integrationExportConsents.connectionId))
    .innerJoin(agents, eq(agents.id, integrationExportConsents.agentId))
    .innerJoin(agentTypes, eq(agentTypes.id, agents.agentTypeId))
    .leftJoin(
      integrationConnectionAssignments,
      and(
        eq(integrationConnectionAssignments.squadId, agents.squadId),
        eq(integrationConnectionAssignments.providerKey, integrationConnections.providerKey),
        eq(integrationConnectionAssignments.connectionId, integrationConnections.id)
      )
    )
    .where(eq(integrationExportBatches.id, batch.id))
    .limit(1)
  if (!row) return { allowed: false as const, code: 'export_state_missing', permanent: true }
  if (row.consent.revokedAt) return { allowed: false as const, code: 'consent_revoked', permanent: true, context: row }
  if (!row.agent.squadId || row.agent.parentAgentId)
    return { allowed: false as const, code: 'agent_ineligible', permanent: true, context: row }
  if (row.assignmentConnectionId !== row.connection.id)
    return { allowed: false as const, code: 'assignment_changed', permanent: true, context: row }
  if (!isSupportedExportDeliveryState(row))
    return { allowed: false as const, code: 'unsupported_export_version', permanent: true, context: row }
  const policy = row.policy as { version?: number; allow?: Record<string, string[]> } | null
  if (policy?.version !== 1 || !policy.allow?.bigbrain?.includes('conversation_export'))
    return { allowed: false as const, code: 'policy_removed', permanent: true, context: row }
  const connection = row.connection
  if (!connection.enabled || !(await isIntegrationEnabled(connection.providerKey)))
    return { allowed: false as const, code: 'connection_disabled', permanent: false, context: row }
  if (connection.authState !== 'authenticated')
    return { allowed: false as const, code: 'connection_auth_invalid', permanent: false, context: row }
  if (connection.healthState !== 'healthy')
    return { allowed: false as const, code: 'connection_unhealthy', permanent: false, context: row }
  if (connection.validatedRevision !== connection.materialRevision)
    return { allowed: false as const, code: 'connection_revision_changed', permanent: false, context: row }
  if (!connection.validationExpiresAt || connection.validationExpiresAt <= new Date())
    return { allowed: false as const, code: 'validation_stale', permanent: false, context: row }
  if (!connection.grantedScopes.includes('inbox:write'))
    return { allowed: false as const, code: 'scope_unavailable', permanent: false, context: row }
  return { allowed: true as const, context: row }
}

export async function resolveExportDelivery(batch: ExportBatchRecord) {
  const decision = await resolveExportDeliveryDecision(batch)
  return decision.allowed ? decision.context : null
}
