import {
  resolveCodeHostReference,
  type CodeHostReference,
  type IntegrationSubscription,
  type WorkflowDefinition,
} from '@tau/shared'

export interface CodeHostingAdapter {
  integration: string
  validateRepository(repository: string): boolean
  changeRequest(
    reference: CodeHostReference,
    squadId: string
  ): Promise<{ merged: boolean; headBranch: string; baseBranch: string } | null>
  containsCommit(reference: CodeHostReference, squadId: string, base: string, commit: string): Promise<boolean>
  subscriptions(reference: CodeHostReference): IntegrationSubscription[]
}

export class CodeHostingRegistry {
  private readonly adapters = new Map<string, CodeHostingAdapter>()
  constructor(adapters: readonly CodeHostingAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.integration)) throw new Error('Duplicate code hosting adapter')
      this.adapters.set(adapter.integration, adapter)
    }
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
    if (!binding?.reference.changeRequest) return explicit
    // IDs are reserved by schema so explicit subscriptions cannot shadow delivery bindings.
    return [
      ...explicit,
      ...binding.adapter.subscriptions(binding.reference).map((subscription) => ({
        ...subscription,
        deliver: { ...subscription.deliver, to: definition.completion.changeEventsTo ?? 'delivery-owner' },
      })),
    ]
  }
}
