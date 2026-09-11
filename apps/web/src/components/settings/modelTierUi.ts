import type { AgentTypeConfig } from '../../api/config'
import type { ProviderAuthEntry } from '../../api/providerAuth'
export function formatResolvedModel(
  agentType: Pick<AgentTypeConfig, 'tier' | 'model' | 'resolvedChain' | 'provenance'>,
  tierLabel?: string
): string {
  if (agentType.provenance?.startsWith('via tier:')) {
    const provenanceTier = agentType.provenance.slice('via tier:'.length).trim()
    return `Model tier: ${tierLabel?.trim() || agentType.tier || provenanceTier}`
  }

  return `Model: ${agentType.resolvedChain || agentType.model}${agentType.provenance ? ` (${agentType.provenance})` : ''}`
}
export function modelChainWarnings(chain: string, providers: ProviderAuthEntry[]): string[] {
  const warnings: string[] = []
  for (const entry of chain.split(',')) {
    const [provider, model] = entry.trim().split(':')
    const state = providers.find((item) => item.provider === provider)
    if (state?.health === 'exhausted' || state?.disabled) warnings.push(`${provider}:${model} provider is unhealthy`)
    const account = state?.accounts?.find((item) => !item.model || item.model === model)
    if (account?.capabilities && !account.capabilities.tools)
      warnings.push(`${provider}:${model} lacks tool capability`)
  }
  return warnings
}
export function withTierPosition(chain: string, spec: string, position: 'primary' | 'fallback'): string {
  const entries = chain
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== spec)
  return position === 'primary' ? [spec, ...entries].join(',') : [...entries, spec].join(',')
}
export async function assignCompatibleProvider<T extends { slug: string; chain: string }>(input: {
  tiers: T[]
  spec: string
  position: 'primary' | 'fallback'
  add: () => Promise<unknown>
  update: (tier: T) => Promise<unknown>
  rollbackProvider: () => Promise<unknown>
}): Promise<void> {
  let providerAdded = false
  try {
    await input.add()
    providerAdded = true
    for (const tier of input.tiers)
      await input.update({ ...tier, chain: withTierPosition(tier.chain, input.spec, input.position) })
  } catch (cause) {
    if (!providerAdded) throw cause
    const restorations = await Promise.allSettled(input.tiers.map(input.update))
    const failedTiers = restorations.flatMap((result, index) =>
      result.status === 'rejected' ? [input.tiers[index].slug] : []
    )
    if (failedTiers.length)
      throw new Error(
        `Assignment failed; rollback incomplete: tiers ${failedTiers.join(', ')} could not be restored; provider retained`,
        { cause }
      )
    try {
      await input.rollbackProvider()
    } catch (rollbackCause) {
      throw new Error('Assignment failed; tiers were restored but provider removal failed; provider retained', {
        cause: rollbackCause,
      })
    }
    throw new Error(
      `Assignment failed and was fully rolled back: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
  }
}
