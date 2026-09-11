export interface ModelTierChain {
  slug: string
  chain: string
}
export interface ResolveModelChainInput {
  agentOverride?: string | null
  typeOverride?: string | null
  tier?: ModelTierChain | null
  tierSlug?: string | null
  instanceDefault: string
}
export type ModelChainProvenance = 'agent override' | 'type override' | `via tier: ${string}` | 'instance default'

/** Resolve a model chain using the binding agent → type → tier → instance precedence. */
export function resolveModelChain(input: ResolveModelChainInput): { chain: string; provenance: ModelChainProvenance } {
  const agentOverride = input.agentOverride?.trim()
  if (agentOverride) return { chain: agentOverride, provenance: 'agent override' }
  const typeOverride = input.typeOverride?.trim()
  if (typeOverride) return { chain: typeOverride, provenance: 'type override' }
  const tierChain = input.tier?.chain.trim()
  if (tierChain) return { chain: tierChain, provenance: `via tier: ${input.tier!.slug}` }
  return { chain: input.instanceDefault, provenance: 'instance default' }
}

import { eq } from 'drizzle-orm'
import { db, modelTiers } from '../../db'
import type { AgentType } from '../../entities/AgentType'

/** Resolve an AgentType through its tier. DEFAULT_MODEL is the explicit instance fallback. */
export async function resolveAgentTypeChain(
  agentType: Pick<AgentType, 'id' | 'model' | 'tier'>,
  agentOverride?: string | null
): Promise<string> {
  const [tier] = agentType.tier
    ? await db
        .select({ slug: modelTiers.slug, chain: modelTiers.chain, disabled: modelTiers.disabled })
        .from(modelTiers)
        .where(eq(modelTiers.slug, agentType.tier))
    : []
  const result = resolveModelChain({
    agentOverride,
    typeOverride: agentType.model,
    tier: tier && !tier.disabled ? tier : null,
    tierSlug: agentType.tier,
    instanceDefault: process.env.DEFAULT_MODEL?.trim() ?? '',
  })
  if (!result.chain)
    throw new Error(`No model chain resolves for agent type ${agentType.id}; configure its model/tier or DEFAULT_MODEL`)
  return result.chain
}
