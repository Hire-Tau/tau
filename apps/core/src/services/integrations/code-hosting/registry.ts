import {
  deliveryPullRequests,
  describeCodeHostReference,
  resolveCodeHostReference,
  type CodeHostReference,
  type IntegrationSubscription,
  type WorkflowDefinition,
} from '@tau/shared'
import { subscriptionTargetsResource, trackedResourceRegistry } from '../tracked-resources'

export interface CodeHostingAdapter {
  integration: string
  validateRepository(repository: string): boolean
  changeRequest(
    reference: CodeHostReference,
    squadId: string
  ): Promise<{ merged: boolean; headBranch: string; baseBranch: string; headSha?: string } | null>
  containsCommit(reference: CodeHostReference, squadId: string, base: string, commit: string): Promise<boolean>
  subscriptions(reference: CodeHostReference): IntegrationSubscription[]
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
  return deliveryPullRequests(metadata).some((resource) => subscriptionTargetsResource(subscription, resource))
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
  /**
   * Why `resolve` returned null, for people. Distinguishes metadata that is present but invalid
   * (for example extra keys on `changeRequest`) from a missing binding, so a delivery failure
   * points at the actual defect instead of claiming required fields are missing.
   */
  explainMissingBinding(metadata: unknown): string {
    const described = describeCodeHostReference(metadata)
    if (described.status === 'invalid')
      return `codeHost metadata is present but invalid: ${described.issues.join('; ')}. Keep verification evidence outside codeHost (for example metadata.delivery).`
    if (described.status === 'valid') {
      const { integration, repository } = described.reference
      if (!this.adapters.has(integration))
        return `codeHost.integration '${integration}' is not a supported code hosting integration (supported: ${[...this.adapters.keys()].join(', ')})`
      return `codeHost.repository '${repository}' is not a valid repository for the ${integration} integration`
    }
    return 'Set codeHost.integration and codeHost.repository to a supported code hosting integration before completion'
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
    // Delivery links already own their reserved ids; only extra links fan out, and they follow
    // their own provider's adapter: a stream may track a Linear issue with no code host at all.
    inferred.push(...trackedResourceRegistry.subscriptions(metadata))
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
