import { describe, expect, test } from 'bun:test'
import { createFakeAdapter, FakeProviderError, fakeGrant, type FakeProviderScript } from './adapter'

describe('fake OAuth provider adapter', () => {
  test('consumes scripted responses and records calls in order', async () => {
    const grant = fakeGrant({ accessToken: 'a1', workspaceId: 'w1' })
    const script: FakeProviderScript = { responses: [grant, 'invalid_grant'], revoked: [], calls: [] }
    const adapter = createFakeAdapter(script)

    expect(
      await adapter.exchangeCode({
        code: 'c',
        redirectUri: 'https://example.test/cb',
        clientId: 'i',
        clientSecret: 's',
      })
    ).toEqual(grant)
    await expect(adapter.refresh({ refreshToken: 'r', clientId: 'i', clientSecret: 's' })).rejects.toEqual(
      new FakeProviderError('invalid_grant')
    )
    await adapter.revoke({ token: 'a1', clientId: 'i', clientSecret: 's' })

    expect(script.calls.map(({ op }) => op)).toEqual(['exchange', 'refresh', 'revoke'])
    expect(script.revoked).toEqual(['a1'])
  })

  test('classifies terminal fake failures and treats all others as retryable', () => {
    const adapter = createFakeAdapter({ responses: [], revoked: [], calls: [] })
    for (const code of ['invalid_grant', 'invalid_auth', 'workspace_identity_mismatch']) {
      expect(adapter.classifyError(new FakeProviderError(code))).toEqual({ code, retryable: false })
    }
    expect(adapter.classifyError(new FakeProviderError('rate_limited'))).toEqual({
      code: 'rate_limited',
      retryable: true,
    })
    expect(adapter.classifyError(new Error('raw secret'))).toEqual({ code: 'provider_error', retryable: true })
  })

  test('uses the fixed fake authorization host', () => {
    const adapter = createFakeAdapter({ responses: [], revoked: [], calls: [] }, 'custom')
    const url = adapter.buildAuthorizationUrl({
      clientId: 'cid',
      redirectUri: 'https://example.test/cb',
      state: 'state',
    })
    expect(adapter.key).toBe('custom')
    expect(adapter.authorizeHosts).toEqual(['fake.test'])
    expect(url.origin).toBe('https://fake.test')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'https://example.test/cb',
      response_type: 'code',
      state: 'state',
    })
  })
})
