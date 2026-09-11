import { parseOAuthCredential } from '../authorization/credential-bundle'
import type { IntegrationAssignmentRepository } from '../connection-repository'
import type { IntegrationProjectionStateRepository } from './state-repository'

export async function discoverProjectionCredentialDrift(input: {
  states: Pick<IntegrationProjectionStateRepository, 'listReady' | 'invalidate'>
  connections: Pick<IntegrationAssignmentRepository, 'getAssigned'>
  credential: (reference: string) => string | undefined
  now: Date
  limit?: number
  after?: { squadId: string; providerKey: string } | null
}): Promise<{ squadId: string; providerKey: string } | null> {
  const limit = input.limit ?? 100
  const states = await input.states.listReady(limit, input.after ?? null)
  for (const state of states) {
    try {
      const assignment = await input.connections.getAssigned(state.squadId, state.providerKey)
      let revision: bigint | null = null
      if (assignment) {
        const raw = input.credential(assignment.credentialRef)
        if (raw) {
          try {
            revision = BigInt(parseOAuthCredential(raw).tokenRevision)
          } catch {
            // Malformed material is deprojected through a null desired revision.
          }
        }
      }
      if (revision !== state.appliedCredentialRevision) {
        await input.states.invalidate({
          squadId: state.squadId,
          providerKey: state.providerKey,
          credentialRevision: revision,
          now: input.now,
        })
      }
    } catch {
      // A corrupt or temporarily unreadable connection must not block unrelated projections.
    }
  }
  if (states.length < limit) return null
  const last = states.at(-1)!
  return { squadId: last.squadId, providerKey: last.providerKey }
}
