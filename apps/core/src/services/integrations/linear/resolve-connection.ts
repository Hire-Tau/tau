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
