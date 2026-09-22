import { describe, expect, test } from 'bun:test'
import { addAccount, type AccountStoreV1 } from './account-store'
import { inspectTierCapabilities } from '../model-selection/tier-capability-policy'
import { selectModelSpec } from '../model-selection/select-model'
import { openAICompatibleRegistrations, registerOpenAICompatibleAccounts } from './auth-backend'
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

test('a worker catalog follows added, changed and disabled accounts without rebuilding on credential updates', () => {
  const configs = new Map<string, any>([['external', { name: 'External test provider' }]])
  let writes = 0
  const runtime = {
    getRegisteredProviderIds: () => [...configs.keys()],
    getRegisteredProviderConfig: (id: string) => configs.get(id),
    getRegisteredNativeProvider: (id: string) => configs.get(id),
    registerNativeProvider: (provider: any) => {
      writes++
      configs.set(provider.id, provider)
    },
    unregisterProvider: (id: string) => {
      configs.delete(id)
    },
  }
  const store: AccountStoreV1 = { version: 1, accounts: {} }
  registerOpenAICompatibleAccounts(runtime, store)
  const account = addAccount(store, 'local', credential, 'Local')
  Object.assign(account, {
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:8080/v1',
    model: 'qwen',
    capabilities,
  })
  registerOpenAICompatibleAccounts(runtime, store)
  expect(configs.get('local').getModels()[0].id).toBe('qwen')
  account.lastUsedAt = 100
  account.credential = { type: 'api_key', key: 'fixture-rotation' }
  registerOpenAICompatibleAccounts(runtime, store)
  expect(writes).toBe(1)
  account.model = 'new-model'
  registerOpenAICompatibleAccounts(runtime, store)
  expect(configs.get('local').getModels()[0].id).toBe('new-model')
  account.enabled = false
  registerOpenAICompatibleAccounts(runtime, store)
  expect(configs.has('local')).toBe(false)
  expect(configs.has('external')).toBe(true)
})

test('a session-scoped runtime can authenticate a registered compatible model', async () => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const key = { type: 'api_key' as const, key: 'fixture-only' }
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    credentials: {
      read: async (provider) => (provider === 'local-fixture' ? key : undefined),
      list: async () => [{ providerId: 'local-fixture', type: 'api_key' as const }],
      modify: async () => key,
      delete: async () => {},
    },
  })
  expect(await runtime.checkAuth('local-fixture')).toBeUndefined()
  registerOpenAICompatibleAccounts(runtime, {
    version: 1,
    accounts: {
      'local-fixture': [
        {
          id: 'local-account',
          enabled: true,
          credential: key,
          kind: 'openai-compatible',
          baseUrl: 'http://localhost:8080/v1',
          model: 'qwen',
          capabilities,
        },
      ],
    },
  })
  expect(runtime.getModel('local-fixture', 'qwen')?.baseUrl).toBe('http://localhost:8080/v1')
  expect(await runtime.checkAuth('local-fixture')).toBeDefined()
  expect((await runtime.getAuth('local-fixture'))?.auth.apiKey).toBe(key.key)
})

test('verified keyless models execute without an Authorization header and follow credential rotation', async () => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  let current: typeof credential | undefined = { type: 'api_key', key: '' }
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    credentials: {
      read: async () => current,
      list: async () => (current ? [{ providerId: 'keyless-fixture', type: 'api_key' as const }] : []),
      modify: async () => current,
      delete: async () => {
        current = undefined
      },
    },
  })
  const store: AccountStoreV1 = {
    version: 1,
    accounts: {
      'keyless-fixture': [
        {
          id: 'fixture',
          enabled: true,
          credential: current!,
          kind: 'openai-compatible',
          baseUrl: 'http://localhost:1/v1',
          model: 'fixture-model',
          capabilities,
        },
      ],
    },
  }
  registerOpenAICompatibleAccounts(runtime, store)
  expect(await runtime.checkAuth('keyless-fixture')).toBeDefined()
  const headers: Array<string | null> = []
  const transport = (async (_url: unknown, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get('authorization'))
    const chunk = {
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'works' }, finish_reason: 'stop' }],
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch
  const model = runtime.getModel('keyless-fixture', 'fixture-model')!
  for (const key of ['', 'test-rotation-key', '']) {
    current = { type: 'api_key', key }
    const response = await runtime.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
      { fetch: transport }
    )
    expect(response.stopReason).toBe('stop')
    expect(response.content).toEqual([{ type: 'text', text: 'works' }])
  }
  expect(headers).toEqual([null, 'Bearer test-rotation-key', null])
  current = undefined
  expect(await runtime.checkAuth('keyless-fixture')).toBeUndefined()
  const missing = await runtime.completeSimple(model, { messages: [] }, { fetch: transport })
  expect(missing.stopReason).toBe('error')
  expect(headers).toHaveLength(3)
  store.accounts['keyless-fixture']![0]!.enabled = false
  registerOpenAICompatibleAccounts(runtime, store)
  expect(runtime.getModel('keyless-fixture', 'fixture-model')).toBeUndefined()
})
