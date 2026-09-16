import {
  deliveryPullRequests,
  resolveCodeHostReference,
  resolveTrackedResources,
  type CodeHostReference,
  type IntegrationSubscription,
  type ResolvedTrackedResource,
  type WorkflowDefinition,
} from '@tau/shared'

export interface CodeHostingAdapter {
  integration: string
  validateRepository(repository: string): boolean
  changeRequest(
    reference: CodeHostReference,
    squadId: string
  ): Promise<{ merged: boolean; headBranch: string; baseBranch: string; headSha?: string } | null>
  containsCommit(reference: CodeHostReference, squadId: string, base: string, commit: string): Promise<boolean>
  subscriptions(reference: CodeHostReference): IntegrationSubscription[]
  /** Events for a resource tracked alongside the delivery binding. Identity only; never a grant. */
  trackedSubscriptions?(resource: ResolvedTrackedResource): IntegrationSubscription[]
  authorizeSquad?(squadId: string, connectionId?: string): Promise<boolean>
}

function matchValue(subscription: IntegrationSubscription, path: string) {
  const match = subscription.match[path]
  return match && 'value' in match ? match.value : undefined
}

/**
 * Feedback on a delivery change request: the reserved code-host ids, plus the tracked
 * subscriptions whose identity is a pull request designated as delivery in `metadata`.
 *
 * Both id prefixes are reserved by schema, so only subscriptions this registry derived can
 * qualify. An author-written explicit subscription is never delivery feedback even when its
 * literal `match` names a delivery pull request: otherwise any flow could mint a subscription
 * that bypasses the delivery-approval wait.
 */
export function isDeliveryFeedbackSubscription(subscription: IntegrationSubscription, metadata: unknown): boolean {
  if (subscription.id.startsWith('code-host-')) return true
  if (!subscription.id.startsWith('tracked-')) return false
  return deliveryPullRequests(metadata).some(
    (resource) =>
      resource.integration === subscription.source.integration &&
      String(matchValue(subscription, 'repository') ?? '')
        .trim()
        .toLowerCase() === resource.repository.trim().toLowerCase() &&
      matchValue(subscription, 'pullRequest.number') === resource.number
  )
}

export class CodeHostingRegistry {
  private readonly adapters = new Map<string, CodeHostingAdapter>()
  constructor(adapters: readonly CodeHostingAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.integration)) throw new Error('Duplicate code hosting adapter')
      this.adapters.set(adapter.integration, adapter)
    }
  }
  adapterFor(integration: string): CodeHostingAdapter | undefined {
    return this.adapters.get(integration)
  }
  resolve(metadata: unknown) {
    const reference = resolveCodeHostReference(metadata)
    const adapter = reference && this.adapters.get(reference.integration)
    return reference && adapter?.validateRepository(reference.repository) ? { reference, adapter } : null
  }
  subscriptions(definition: WorkflowDefinition, metadata: unknown): IntegrationSubscription[] {
    const explicit = definition.subscriptions ?? []
    if (!definition.completion.followChanges) return explicit
    const binding = this.resolve(metadata)
    const inferred = binding
      ? binding.reference.changeRequest
        ? binding.adapter.subscriptions(binding.reference)
        : []
      : []
    // Delivery links already own their reserved ids; only extra links fan out.
    for (const resource of resolveTrackedResources(metadata)) {
      if (resource.source !== 'tracked') continue
      const adapter = this.adapters.get(resource.integration)
      if (!adapter?.trackedSubscriptions || !adapter.validateRepository(resource.repository)) continue
      inferred.push(...adapter.trackedSubscriptions(resource))
    }
    // IDs are reserved by schema so explicit subscriptions cannot shadow delivery bindings.
    return [
      ...explicit,
      ...inferred.map((subscription) => ({
        ...subscription,
        deliver: { ...subscription.deliver, to: definition.completion.changeEventsTo ?? 'delivery-owner' },
      })),
    ]
  }
}
