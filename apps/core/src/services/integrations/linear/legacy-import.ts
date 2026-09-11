import { db, integrationConnections, settings } from '../../../db'
import { eq } from 'drizzle-orm'
import type { SecretStore } from '../../secrets/store'

const marker = '__integration-migration:linear-credential'
const connectionId = '43956328-8dc6-4b08-9cd9-9089322e470f'
const credentialRef = '__integration-credential:linear-legacy-import:bearer'

/** Import without network access or silently authorizing any squad. Validate and enable in Integrations. */
export async function importLegacyLinearCredential(store: SecretStore) {
  const [imported] = await db.select().from(settings).where(eq(settings.key, marker))
  if (imported) {
    if (store.get('LINEAR_API_KEY')) await store.set('LINEAR_API_KEY', '', 'integration-migration')
    if (store.get('LINEAR_USER_ID')) await store.set('LINEAR_USER_ID', '', 'integration-migration')
    return
  }
  const credential = store.get('LINEAR_API_KEY')
  if (!credential) return
  await store.mutateSecret(
    credentialRef,
    (current) => (current === undefined ? credential : undefined),
    'integration-migration'
  )
  await db.transaction(async (tx) => {
    await tx
      .insert(integrationConnections)
      .values({
        id: connectionId,
        providerKey: 'linear',
        adapterVersion: 1,
        displayName: 'Imported Linear account',
        configuration: { version: 1 },
        credentialRef,
        materialRevision: connectionId,
      })
      .onConflictDoNothing()
    await tx.insert(settings).values({ key: marker, value: connectionId }).onConflictDoNothing()
  })
  // Persist tombstones so an old environment setting cannot revive this credential path.
  await store.set('LINEAR_API_KEY', '', 'integration-migration')
  await store.set('LINEAR_USER_ID', '', 'integration-migration')
}
