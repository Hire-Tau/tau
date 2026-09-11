import { describe, expect, test } from 'bun:test'
import { addAccount, type AccountStoreV1 } from './account-store'
import { inspectTierCapabilities } from '../model-selection/tier-capability-policy'
import { selectModelSpec } from '../model-selection/select-model'
import { openAICompatibleRegistrations } from './auth-backend'
const credential = { type: 'api_key' as const, key: '' }
const capabilities = { tools: true, probedAt: '2026-01-01T00:00:00Z' }
describe('compatible runtime registrations', () => {
  test('preserves keyless account provider, URL, and model identity', () => {
    const store: AccountStoreV1 = {
      version: 1,
      accounts: {
        local: [
          {
            id: 'a',
            enabled: true,
            credential,
            kind: 'openai-compatible',
            providerId: 'local',
            baseUrl: 'http://localhost:8080/v1',
            model: 'qwen',
            capabilities,
          },
        ],
      },
    }
    expect(
      openAICompatibleRegistrations(store).map(({ providerId, account }) => [
        providerId,
        account.baseUrl,
        account.model,
        account.credential,
      ])
    ).toEqual([['local', 'http://localhost:8080/v1', 'qwen', credential]])
  })
  test('registers verified tool-less providers for last-resort fallback', () => {
    const store: AccountStoreV1 = {
      version: 1,
      accounts: {
        unsafe: [
          {
            id: 'x',
            enabled: true,
            credential,
            kind: 'openai-compatible',
            providerId: 'unsafe',
            baseUrl: 'http://localhost:1/v1',
            model: 'bad',
            capabilities: { tools: false, probedAt: 'now' },
          },
        ],
      },
    }
    expect(openAICompatibleRegistrations(store).map(({ providerId }) => providerId)).toEqual(['unsafe'])
  })
  test('does not collapse duplicate model ids from different servers', () => {
    const account = (providerId: string, baseUrl: string) => ({
      id: providerId,
      enabled: true,
      credential,
      kind: 'openai-compatible' as const,
      providerId,
      baseUrl,
      model: 'same-model',
      capabilities,
    })
    const store: AccountStoreV1 = {
      version: 1,
      accounts: {
        localA: [account('local-a', 'http://localhost:8080/v1')],
        localB: [account('local-b', 'http://localhost:1234/v1')],
      },
    }
    expect(openAICompatibleRegistrations(store).map(({ providerId }) => providerId)).toEqual(['local-a', 'local-b'])
  })
  test('created tool-less account can be saved last and selected at runtime', () => {
    const store: AccountStoreV1 = { version: 1, accounts: {} }
    const created = addAccount(store, 'fallback-local', credential, 'Fallback')
    Object.assign(created, {
      kind: 'openai-compatible',
      providerId: 'fallback-local',
      baseUrl: 'http://localhost:8080/v1',
      model: 'qwen:latest',
      capabilities: { tools: false, contextWindow: 32768, probedAt: 'now' },
    })
    const chain = 'anthropic:claude-sonnet-4-5,fallback-local:qwen:latest'
    expect(inspectTierCapabilities(chain, [created], 16384).errors).toEqual([])
    const registration = openAICompatibleRegistrations(store)[0]
    const model = { id: registration.account.model!, provider: registration.providerId } as any
    expect(
      selectModelSpec('fallback-local:qwen:latest', {
        isProviderConfigured: () => true,
        isProviderDisabled: () => false,
        modelCatalog: {
          getProviders: () => [{ id: registration.providerId }],
          getModel: (provider, id) => (provider === registration.providerId && id === model.id ? model : undefined),
        },
      }).selected
    ).toBe('fallback-local:qwen:latest')
  })
})
