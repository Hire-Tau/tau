import { eq } from 'drizzle-orm'
import { integrationRevocationJobs } from '../../../db'
import type { SecretStore } from '../../secrets/store'
import type { OAuthAuthority } from './authority'

export interface StageRevocationArtifactInput {
  credentialRef: string
  credential: string
  providerKey: string
  adapterVersion: number
  clientAuthority: OAuthAuthority
  actor: string
}

/** Atomically persists a rollback artifact and the job that owns its eventual revocation. */
export class RevocationArtifactStager {
  constructor(private readonly secrets: Pick<SecretStore, 'setWithDurableObligation' | 'refreshKey'>) {}

  async stage(input: StageRevocationArtifactInput): Promise<void> {
    try {
      await this.secrets.setWithDurableObligation(input.credentialRef, input.credential, input.actor, async (tx) => {
        await tx
          .insert(integrationRevocationJobs)
          .values({
            providerKey: input.providerKey,
            adapterVersion: input.adapterVersion,
            clientAuthority: input.clientAuthority,
            credentialRef: input.credentialRef,
          })
          .onConflictDoNothing({ target: integrationRevocationJobs.credentialRef })
        const [job] = await tx
          .select({
            providerKey: integrationRevocationJobs.providerKey,
            adapterVersion: integrationRevocationJobs.adapterVersion,
            clientAuthority: integrationRevocationJobs.clientAuthority,
          })
          .from(integrationRevocationJobs)
          .where(eq(integrationRevocationJobs.credentialRef, input.credentialRef))
        if (
          !job ||
          job.providerKey !== input.providerKey ||
          job.adapterVersion !== input.adapterVersion ||
          job.clientAuthority !== input.clientAuthority
        ) {
          throw new Error('Revocation artifact obligation mismatch')
        }
      })
    } catch (error) {
      // If PostgreSQL committed before the acknowledgement was lost, reconcile
      // the process-local cache before the caller adopts the durable job.
      await this.secrets.refreshKey(input.credentialRef)
      throw error
    }
  }
}
