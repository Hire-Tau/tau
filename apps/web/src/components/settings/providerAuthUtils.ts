import type { QueryClient } from '@tanstack/react-query'
import type { ProviderAuthEntry } from '../../api/providerAuth'
import { queryKeys, onboardingQueryKeys } from '../../queryKeys'

export interface CatalogEntryLike {
  id: string
  label: string
}

/** Catalog providers that are not already shown as cards or configured. */
export function selectableProviders<T extends CatalogEntryLike>(catalog: T[], hiddenIds: Set<string>): T[] {
  return catalog.filter((p) => !hiddenIds.has(p.id))
}

/**
 * Sort rank for provider cards: providers with a usable account first, then
 * providers whose stored accounts are all disabled, then providers with no
 * accounts. The order within each group remains the registry/catalog order.
 */
export function providerActivityRank(entries: Array<ProviderAuthEntry | undefined>): 0 | 1 | 2 {
  const presentEntries = entries.filter((entry): entry is ProviderAuthEntry => entry !== undefined)
  const hasEnabledAccount = presentEntries.some((entry) => {
    if (entry.disabled) return false
    if (entry.accounts !== undefined) {
      return entry.accounts.some((account) => account.enabled && account.hasCredential !== false)
    }
    return entry.hasCredential
  })

  if (hasEnabledAccount) return 0
  if (presentEntries.some((entry) => (entry.accounts?.length ?? 0) > 0 || entry.hasCredential)) return 1
  return 2
}

export function extractOAuthCode(input: string): string {
  const value = input.trim()
  if (!value) return ''

  try {
    const url = new URL(value)
    return url.searchParams.get('code')?.trim() || value
  } catch {
    return value
  }
}

/** Refresh auth cards and any derived model-tier rows after a credential mutation. */
export function invalidateProviderRoutingQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: onboardingQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.providerAuth.all }),
    queryClient.invalidateQueries({ queryKey: ['model-tiers'] }),
  ])
}
