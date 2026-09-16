import {
  deliveryPullRequests,
  describeCodeHostReference,
  resolveCodeHostReference,
  resolveTrackedResources,
  type CodeHostReference,
  type IntegrationSubscription,
  type ResolvedTrackedResource,
  type TrackedResourceKind,
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
 * Whether `subscription`'s literal `match` values identify `resource`: same integration,
 * repository compared trimmed and case-insensitively, and the resource's number compared on the
 * kind-appropriate match path (`issue.number` or `pullRequest.number`).
 *
 * `matchValue` only reads a literal `value`, so a `streamMetadata`-bound match — which carries no
 * fixed value of its own — never matches here, no matter what the stream currently binds it to.
 */
export function subscriptionTargetsResource(
  subscription: IntegrationSubscription,
  resource: { integration: string; repository: string; kind: TrackedResourceKind; number: number }
): boolean {
  const numberPath = resource.kind === 'issue' ? 'issue.number' : 'pullRequest.number'
  return (
    subscription.source.integration === resource.integration &&
    String(matchValue(subscription, 'repository') ?? '')
      .trim()
      .toLowerCase() === resource.repository.trim().toLowerCase() &&
    matchValue(subscription, numberPath) === resource.number
  )
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
