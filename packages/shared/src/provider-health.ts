export const PROVIDER_HEALTH_KINDS = [
  'rate-limit',
  'plan-credit',
  'capacity',
  'error',
  'invalid-credential',
  'expired-oauth',
  'network',
] as const

export type ProviderHealthKind = (typeof PROVIDER_HEALTH_KINDS)[number]

export interface ProviderHealthRecord {
  provider: string
  accountId?: string
  kind: ProviderHealthKind
  /** Sanitized operator context, never a classification input. */
  message: string
  since: number
  retryAt?: number
  lastSuccessAt?: number
}

/** A concrete provider/account route expanded from an enabled model chain. */
export interface ProviderRoute {
  provider: string
  accountId?: string
  credentialUsable: boolean
}

function routeKey(route: Pick<ProviderRoute, 'provider' | 'accountId'>): string {
  return `${route.provider}\u0000${route.accountId ?? ''}`
}

function recordRecovered(record: ProviderHealthRecord): boolean {
  return record.lastSuccessAt != null && record.lastSuccessAt > record.since
}

/**
 * Resolve the authoritative active failure for a route. Exact-account state
 * takes precedence over provider-wide fallback, including when a later success
 * makes that exact record stale.
 */
export function resolveProviderHealthRecord(
  route: Pick<ProviderRoute, 'provider' | 'accountId'>,
  records: readonly ProviderHealthRecord[]
): ProviderHealthRecord | undefined {
  const exact = route.accountId
    ? records.find((record) => record.provider === route.provider && record.accountId === route.accountId)
    : undefined
  if (exact) return recordRecovered(exact) ? undefined : exact

  const providerWide = records.find((record) => record.provider === route.provider && record.accountId == null)
  return providerWide && !recordRecovered(providerWide) ? providerWide : undefined
}

export function isProviderRouteHealthy(route: ProviderRoute, records: readonly ProviderHealthRecord[]): boolean {
  return route.credentialUsable && resolveProviderHealthRecord(route, records) == null
}

export type RouteDecision = { state: 'ready' } | { state: 'cooldown'; retryAt: number }

/**
 * Decide whether execution may use a concrete route. Cooldown expiry permits
 * a recovery attempt without erasing the unresolved operator-health record.
 */
export function routeDecision(
  route: Pick<ProviderRoute, 'provider' | 'accountId'>,
  records: readonly ProviderHealthRecord[],
  now: number
): RouteDecision {
  const record = resolveProviderHealthRecord(route, records)
  if (record == null || record.kind === 'invalid-credential' || record.kind === 'expired-oauth') {
    return { state: 'ready' }
  }
  return Number.isFinite(record.retryAt) && record.retryAt! > now
    ? { state: 'cooldown', retryAt: record.retryAt! }
    : { state: 'ready' }
}

/** True only when at least one enabled route exists and every unique route is unavailable. */
export function fleetStarved(
  enabledChains: readonly (readonly ProviderRoute[])[],
  records: readonly ProviderHealthRecord[]
): boolean {
  const routes = new Map<string, ProviderRoute>()
  for (const chain of enabledChains) {
    for (const route of chain) {
      const key = routeKey(route)
      const prior = routes.get(key)
      routes.set(key, prior ? { ...route, credentialUsable: prior.credentialUsable || route.credentialUsable } : route)
    }
  }
  return routes.size > 0 && [...routes.values()].every((route) => !isProviderRouteHealthy(route, records))
}
