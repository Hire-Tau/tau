import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { wrapAgentOnResponseForHealth } from './AgentSession'
import { providerHealth, resetProviderHealthForTests } from '../services/provider-health/registry'

function harness(getAccountId?: () => string | undefined) {
  let responseHook: ((response: any, model: any) => Promise<void>) | undefined
  const chained = mock(async () => {})
  const fakeAgent = {
    streamFunction: mock((_model: any, _context: any, options: any) => {
      responseHook = options.onResponse
      return {}
    }),
  }
  wrapAgentOnResponseForHealth({ agent: fakeAgent } as any, getAccountId)
  const request = (provider: string) => fakeAgent.streamFunction({ provider }, {}, { onResponse: chained }) as unknown
  return { request, chained, response: (value: any, model = {}) => responseHook!(value, model) }
}

describe('wrapAgentOnResponseForHealth', () => {
  beforeEach(() => resetProviderHealthForTests())

  it('marks the immutable request provider exhausted on a 429 response', async () => {
    const h = harness()
    h.request('openrouter')
    await h.response({ status: 429, headers: { 'retry-after': '5' } })
    expect(providerHealth.getRecord('openrouter')?.kind).toBe('rate-limit')
  })

  it('keeps immutable provider/account attribution when mutable session state changes before response', async () => {
    let accountId = 'acc_1'
    const h = harness(() => accountId)
    h.request('anthropic')
    accountId = 'acc_2'
    await h.response({ status: 429, headers: {} }, { provider: 'openrouter' })

    expect(providerHealth.getRecord('anthropic', 'acc_1')?.kind).toBe('rate-limit')
    expect(providerHealth.getRecord('anthropic', 'acc_2')).toBeUndefined()
    expect(providerHealth.getRecord('openrouter')).toBeUndefined()
  })

  it('preserves the request onResponse handler', async () => {
    const h = harness()
    h.request('anthropic')
    await h.response({ status: 429, headers: {} })
    expect(h.chained).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a healthy 200', async () => {
    const h = harness()
    h.request('openrouter')
    await h.response({ status: 200, headers: {} })
    expect(providerHealth.getRecord('openrouter')).toBeUndefined()
  })

  it('never throws on unparseable header values', async () => {
    const h = harness()
    h.request('openrouter')
    await h.response({ status: 429, headers: { 'retry-after': 'not-a-date' } })
    expect(providerHealth.getRecord('openrouter')?.kind).toBe('rate-limit')
  })
})
