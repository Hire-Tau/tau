import { describe, expect, test } from 'bun:test'
import type { AccountStoreV1 } from './account-store'
import { hasUsableAccount, selectAccount } from './account-selection'

describe('account-selection', () => {
  test('selects first enabled healthy account', () => {
    const store = {
      version: 1,
      accounts: {
        anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' } }],
      },
    } as AccountStoreV1

    const result = selectAccount('anthropic', store, { isAccountHealthy: () => true })

    expect(result?.id).toBe('a1')
  })

  test('skips disabled accounts', () => {
    const store = {
      version: 1,
      accounts: {
        anthropic: [
          { id: 'a1', enabled: false, credential: { type: 'api_key', key: 'k1' } },
          { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'k2' } },
        ],
      },
    } as AccountStoreV1

    const result = selectAccount('anthropic', store, { isAccountHealthy: () => true })

    expect(result?.id).toBe('a2')
  })

  test('skips unhealthy accounts', () => {
    const store = {
      version: 1,
      accounts: {
        anthropic: [
          { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' } },
          { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'k2' } },
        ],
      },
    } as AccountStoreV1

    const result = selectAccount('anthropic', store, {
      isAccountHealthy: (_provider, accountId) => accountId !== 'a1',
    })

    expect(result?.id).toBe('a2')
  })

  test('prefers array order over lastUsedAt — no LRU round-robin', () => {
    const store = {
      version: 1,
      accounts: {
        anthropic: [
          // a1 is stale and a2 was used more recently, but a1 is still first
          // in preference order, so it must keep winning (repeatedly).
          { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' }, lastUsedAt: 100 },
          { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'k2' }, lastUsedAt: 200 },
        ],
      },
    } as AccountStoreV1

    expect(selectAccount('anthropic', store, { isAccountHealthy: () => true })?.id).toBe('a1')
    expect(selectAccount('anthropic', store, { isAccountHealthy: () => true })?.id).toBe('a1')
  })

  test('falls over to the next account in order when the preferred one is unhealthy, and returns to it once it recovers', () => {
    const store = {
      version: 1,
      accounts: {
        anthropic: [
          { id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' } },
          { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'k2' } },
        ],
      },
    } as AccountStoreV1

    // a1 exhausted — failover walks down to a2.
    expect(selectAccount('anthropic', store, { isAccountHealthy: (_p, id) => id !== 'a1' })?.id).toBe('a2')

    // a1 recovers — selection returns to the preferred account.
    expect(selectAccount('anthropic', store, { isAccountHealthy: () => true })?.id).toBe('a1')
  })

  test('returns null when all accounts are disabled or unhealthy', () => {
    const store = {
      version: 1,
      accounts: {
        anthropic: [
          { id: 'a1', enabled: false, credential: { type: 'api_key', key: 'k1' } },
          { id: 'a2', enabled: true, credential: { type: 'api_key', key: 'k2' } },
        ],
      },
    } as AccountStoreV1

    const result = selectAccount('anthropic', store, { isAccountHealthy: () => false })

    expect(result).toBeNull()
  })

  test('hasUsableAccount reports whether any enabled healthy account exists', () => {
    const store = {
      version: 1,
      accounts: {
        anthropic: [{ id: 'a1', enabled: true, credential: { type: 'api_key', key: 'k1' } }],
        openai: [{ id: 'o1', enabled: false, credential: { type: 'api_key', key: 'k2' } }],
      },
    } as AccountStoreV1

    expect(hasUsableAccount('anthropic', store, { isAccountHealthy: () => true })).toBe(true)
    expect(hasUsableAccount('anthropic', store, { isAccountHealthy: () => false })).toBe(false)
    expect(hasUsableAccount('openai', store, { isAccountHealthy: () => true })).toBe(false)
  })
})
