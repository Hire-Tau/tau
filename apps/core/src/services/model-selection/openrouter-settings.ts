import { getSettingsStore } from '../settings'

export const OPENROUTER_TIER_EXPANSION_KEY = 'OPENROUTER_TIER_EXPANSION_ENABLED'

/** Explicit opt-in. Stored credentials alone never enable tier expansion. */
export function isOpenRouterTierExpansionEnabled(): boolean {
  return getSettingsStore().get(OPENROUTER_TIER_EXPANSION_KEY) === 'true'
}

export async function setOpenRouterTierExpansionEnabled(enabled: boolean, actor = 'admin'): Promise<void> {
  await getSettingsStore().set(OPENROUTER_TIER_EXPANSION_KEY, String(enabled), actor)
}
