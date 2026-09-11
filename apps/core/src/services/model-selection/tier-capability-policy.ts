import { parseModelSpec } from '../../lib/utils/model-spec'
export interface CapabilityAccount {
  model?: string
  providerId?: string
  capabilities?: { tools: boolean; contextWindow?: number }
}
export function inspectTierCapabilities(
  chain: string,
  accounts: CapabilityAccount[],
  contextFloor: number
): { errors: string[]; warnings: string[] } {
  const entries = chain
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const errors: string[] = []
  const warnings: string[] = []
  entries.forEach((entry, index) => {
    const { provider, modelId: model } = parseModelSpec(entry)
    const account = accounts.find((candidate) => candidate.providerId === provider && candidate.model === model)
    if (!account) return
    if (!account?.capabilities) return
    const label = `${provider}:${model}`
    if (!account.capabilities.tools && index === 0) errors.push(`Tool-less model ${label} cannot be Primary`)
    else if (!account.capabilities.tools && index < entries.length - 1)
      warnings.push(`Tool-less model ${label} is not a last-resort fallback`)
    const context = account.capabilities.contextWindow
    if (context != null && context < contextFloor)
      warnings.push(`Model ${label} context window ${context} is below ${contextFloor}`)
  })
  return { errors, warnings }
}
