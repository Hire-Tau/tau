import { isPlatformManaged } from '../../secrets/managed'
import { platformRequest } from '../../platform/instance-client'
import {
  resolveGitHubConnection,
  resolveGitHubRelayAssignment,
  resolveInstanceGitHubConnection,
} from '../github/resolve-connection'
import { listGitHubPrWorkStreamCandidates, listGitHubTriggerSquads } from '../github/database-watch-source'
import { publishIntegrationOutputs } from '../outputs/runtime'
import { DbEventPollingDispatchStore } from '../db-event-polling-dispatch-store'
import { extractGitHubPrDispatchFact } from '../../squad-activity/github-pr-fact'
import { materializeGitHubDispatch } from '../../squad-activity/materialize'
import { createLogger } from '../../../lib/infra/logger'
import { discoverGitHubRelayInterests } from './github-interests'
import { HostedIntegrationRelayRunner } from './runner'
import type { RelayDelivery } from '@tau/shared/integration-relay'
import type { RepositoryInterest } from './github-interests'

const log = createLogger('hosted-integration-relay')
const receipts = new DbEventPollingDispatchStore()
export const hostedIntegrationRelayRuntime = new HostedIntegrationRelayRunner({
  managed: isPlatformManaged,
  interests: () =>
    discoverGitHubRelayInterests({
      listWorkStreams: listGitHubPrWorkStreamCandidates,
      listSquads: listGitHubTriggerSquads,
      resolveConnection: resolveGitHubRelayAssignment,
    }),
  resolve: async (id) => {
    const resolved = await resolveInstanceGitHubConnection(id)
    return (
      resolved && { id, revision: resolved.connection.materialRevision, accessToken: resolved.credential.accessToken }
    )
  },
  request: platformRequest,
  dispatch: dispatchHostedGitHubDelivery,
  onError: (code) => log.warn(`Hosted GitHub delivery deferred: ${code}`),
})

export async function dispatchHostedGitHubDelivery(delivery: RelayDelivery, interests: RepositoryInterest[]) {
  const event = {
    type: delivery.eventType,
    payload: delivery.payload,
    metadata: { providerDeliveryId: delivery.deliveryId },
  }
  // Connection-scoped output facts own agent routing. Instance-wide legacy shell rules
  // are deliberately not an authority path for a shared App's tenant-scoped events.
  for (const squadId of new Set(interests.map((interest) => interest.squadId))) {
    const live = await resolveGitHubConnection(squadId, delivery.connectionId)
    // Expiry may race a successful pull. Leave the lease unacknowledged so fresh authorization can retry.
    if (!live) throw new Error('relay_authorization_unavailable')
    if (live.connection.materialRevision !== delivery.connectionRevision) continue
    await publishIntegrationOutputs('github', event, {
      kind: 'connection',
      connectionId: delivery.connectionId,
      connectionRevision: delivery.connectionRevision,
      squadId,
    })
    const fact = extractGitHubPrDispatchFact('github', event)
    if (!fact || fact.repository !== delivery.resourceKey) continue
    const key = `relay:${delivery.connectionId}:${squadId}:${fact.logicalRowId}`
    const claim = await receipts.claim('github', key, 120_000)
    if (claim.status === 'busy') throw new Error('relay_receipt_busy')
    const completed =
      claim.status === 'completed'
        ? claim.dispatch
        : await receipts.complete('github', key, claim.leaseToken, {
            eventFact: fact,
            eventOccurredAt: new Date(fact.occurredAt),
            activitySquadId: squadId,
          })
    if (completed) await materializeGitHubDispatch(completed.activityId, squadId)
  }
}
