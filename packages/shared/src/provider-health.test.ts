import { describe, expect, test } from 'bun:test'
import {
  PROVIDER_HEALTH_KINDS,
  fleetStarved,
  resolveProviderHealthRecord,
  routeDecision,
  type ProviderHealthRecord,
  type ProviderRoute,
} from './provider-health'

const unhealthy = (
  provider: string,
  kind: ProviderHealthRecord['kind'] = 'rate-limit',
  accountId?: string
): ProviderHealthRecord => ({
  provider,
  ...(accountId ? { accountId } : {}),
  kind,
  message: 'Sanitized provider failure.',
  since: 100,
})
const route = (provider: string, accountId?: string, credentialUsable = true): ProviderRoute => ({
  provider,
  ...(accountId ? { accountId } : {}),
  credentialUsable,
})

describe('shared provider health contract', () => {
  test('exports exactly the seven operator-authoritative kinds without usage_cap', () => {
    const expectedKinds: ProviderHealthRecord['kind'][] = [
      'rate-limit',
      'plan-credit',
      'capacity',
      'error',
      'invalid-credential',
      'expired-oauth',
      'network',
    ]
    expect([...PROVIDER_HEALTH_KINDS].sort()).toEqual(expectedKinds.sort())
    // @ts-expect-error usage_cap must never widen the exported kind union.
    const rejectedKind: ProviderHealthRecord['kind'] = 'usage_cap'
    expect(rejectedKind as string).toBe('usage_cap')
  })

  test('resolves an absent record healthy only when credentials are usable', () => {
    expect(fleetStarved([[route('anthropic', 'a1')]], [])).toBe(false)
    expect(fleetStarved([[route('anthropic', 'a1', false)]], [])).toBe(true)
  })

  test('is fleet starved only when every route in enabled chains is unhealthy', () => {
    const chains = [[route('anthropic', 'a1')], [route('openai-codex', 'o1')]]

    expect(fleetStarved(chains, [unhealthy('anthropic', 'rate-limit', 'a1')])).toBe(false)
    expect(
      fleetStarved(chains, [
        unhealthy('anthropic', 'rate-limit', 'a1'),
        unhealthy('openai-codex', 'expired-oauth', 'o1'),
      ])
    ).toBe(true)
  })

  test('an unused healthy provider does not rescue enabled unhealthy routes', () => {
    const unusedRecovered = { ...unhealthy('openai-codex', 'network', 'o1'), lastSuccessAt: 101 }

    expect(
      fleetStarved([[route('anthropic', 'a1')]], [unhealthy('anthropic', 'plan-credit', 'a1'), unusedRecovered])
    ).toBe(true)
  })

  test('prefers the exact account record over provider-wide fallback', () => {
    const providerWide = unhealthy('anthropic', 'network')
    const account = unhealthy('anthropic', 'expired-oauth', 'a1')

    expect(resolveProviderHealthRecord(route('anthropic', 'a1'), [providerWide, account])).toBe(account)
    expect(resolveProviderHealthRecord(route('anthropic', 'a2'), [providerWide, account])).toBe(providerWide)
  })

  test('exact-account recovery wins over provider-wide unhealthy fallback', () => {
    const providerWide = unhealthy('anthropic', 'network')
    const recoveredAccount = { ...unhealthy('anthropic', 'rate-limit', 'a1'), lastSuccessAt: 101 }

    expect(fleetStarved([[route('anthropic', 'a1')]], [providerWide, recoveredAccount])).toBe(false)
  })

  test('an exact-account record does not make a healthy sibling account unavailable', () => {
    const enabledChains = [[route('anthropic', 'a1'), route('anthropic', 'a2')]]

    expect(fleetStarved(enabledChains, [unhealthy('anthropic', 'rate-limit', 'a1')])).toBe(false)
  })

  test('a provider-level unhealthy record applies to every account route for that provider', () => {
    const enabledChains = [[route('anthropic', 'a1'), route('anthropic', 'a2')]]

    expect(fleetStarved(enabledChains, [unhealthy('anthropic', 'network')])).toBe(true)
  })

  test('a genuine later success makes the applicable stale record healthy', () => {
    const record = { ...unhealthy('anthropic', 'network', 'a1'), lastSuccessAt: 101 }

    expect(fleetStarved([[route('anthropic', 'a1')]], [record])).toBe(false)
  })

  test('elapsed retryAt does not make an unresolved record healthy', () => {
    const record = { ...unhealthy('anthropic', 'rate-limit', 'a1'), retryAt: 1 }

    expect(fleetStarved([[route('anthropic', 'a1')]], [record])).toBe(true)
  })

  test('routes an unobserved route immediately', () => {
    expect(routeDecision(route('anthropic', 'a1'), [], 1_000)).toEqual({ state: 'ready' })
  })

  test('holds a transient route until its retry time and then permits recovery', () => {
    const record = { ...unhealthy('anthropic', 'rate-limit', 'a1'), retryAt: 61_000 }

    expect(routeDecision(route('anthropic', 'a1'), [record], 60_999)).toEqual({
      state: 'cooldown',
      retryAt: 61_000,
    })
    expect(routeDecision(route('anthropic', 'a1'), [record], 61_000)).toEqual({ state: 'ready' })
  })

  test('keeps credential failures observational-only for routing', () => {
    for (const kind of ['invalid-credential', 'expired-oauth'] as const) {
      const record = { ...unhealthy('anthropic', kind, 'a1'), retryAt: 61_000 }
      expect(routeDecision(route('anthropic', 'a1'), [record], 1_000)).toEqual({ state: 'ready' })
    }
  })

  test('fails open for a malformed transient retry time', () => {
    const record = { ...unhealthy('anthropic', 'network', 'a1'), retryAt: Number.NaN }

    expect(routeDecision(route('anthropic', 'a1'), [record], 1_000)).toEqual({ state: 'ready' })
  })

  test('deduplicates concrete routes before evaluating starvation', () => {
    const unusableDuplicate = route('anthropic', 'a1', false)
    const usableDuplicate = route('anthropic', 'a1', true)

    expect(fleetStarved([[unusableDuplicate, usableDuplicate]], [])).toBe(false)
  })

  test('an intentionally empty route set is not fleet starved', () => {
    expect(fleetStarved([], [unhealthy('anthropic')])).toBe(false)
  })
})
