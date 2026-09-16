import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { getSecretStore } from '../../secrets'
export async function resolveLinearConnection(squadId: string) {
  const connection = await new DbIntegrationConnectionRepository().getAssigned(squadId, 'linear')
  if (
    !connection?.enabled ||
    connection.authState !== 'authenticated' ||
    connection.healthState !== 'healthy' ||
    connection.materialRevision !== connection.validatedRevision ||
    !connection.validationExpiresAt ||
    connection.validationExpiresAt.getTime() <= Date.now()
  )
    return null
  const store = getSecretStore()
  await store.refreshKey(connection.credentialRef)
  const credential = store.get(connection.credentialRef)
  return credential ? { connection, credential } : null
}

/**
 * A declared Linear assignment, for authorization checks that need no credential. Validation
 * freshness is deliberately not required: losing it suspends delivery, not the squad's interest.
 */
export async function resolveLinearAssignment(squadId: string) {
  const connection = await new DbIntegrationConnectionRepository().getAssigned(squadId, 'linear')
  if (!connection?.enabled || connection.authState !== 'authenticated') return undefined
  return { id: connection.id }
}
