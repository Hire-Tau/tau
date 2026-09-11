import { describe, expect, test } from 'bun:test'
import type { ZodType } from 'zod'
import { createBrokerTransport, operationKey } from './broker-transport'

interface RequestCall {
  path: string
  body: Record<string, unknown>
}

function harness() {
  const calls: RequestCall[] = []
  const request = async <T>(input: { path: string; body: unknown; schema: ZodType<T> }): Promise<T> => {
    calls.push({ path: input.path, body: input.body as Record<string, unknown> })
    if (input.path.endsWith('/start')) {
      return {
        authorizationUrl: 'https://api.notion.com/v1/oauth/authorize?state=x',
        transactionId: crypto.randomUUID(),
        expiresAt: '2030-01-01T00:00:00.000Z',
      } as T
    }
    if (input.path.endsWith('/redeem')) {
      return {
        configuration: { version: 1, workspaceId: 'workspace', botId: 'bot' },
        credential: { accessToken: 'access', refreshToken: 'refresh', expiresAt: null },
        displayName: 'Workspace',
      } as T
    }
    if (input.path.endsWith('/refresh')) {
      return {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresAt: null,
        configuration: { version: 1, workspaceId: 'workspace', botId: 'bot' },
      } as T
    }
    return { revoked: true } as T
  }
  return { calls, transport: createBrokerTransport(request) }
}

describe('broker OAuth transport', () => {
  test('operation keys match independent literal SHA-256 vectors', () => {
    expect(operationKey.redeem('flow-123')).toBe('27efd3f4881ac97ffe9a3bf4ab32b63dbd757fcabc058df03ce2c71ee09efc88')
    expect(operationKey.refresh('connection-A', 'material-A', 7)).toBe(
      '1694d46d739340ddf31f41e6504e396e55978babb42cc48484a32fbd8f97642b'
    )
    expect(operationKey.revoke('credential-ref-A')).toBe(
      'fbcd263de13555c054e6e531d35c940d92bd58c0a62a6531633778de31c5ad39'
    )
  })

  test('binds recorded retry keys to connection, material, and token revisions independently', async () => {
    const { calls, transport } = harness()
    const redeem = () =>
      transport.completeAuthorization({ providerKey: 'notion', localFlowId: 'flow-123', handle: 'h'.repeat(43) })
    const refresh = (connectionId: string, materialRevision: string, tokenRevision: number) =>
      transport.refresh({
        providerKey: 'notion',
        connectionId,
        materialRevision,
        tokenRevision,
        refreshToken: 'refresh',
      })
    const revoke = () => transport.revoke({ providerKey: 'notion', credentialRef: 'credential-ref-A', token: 'access' })

    await redeem()
    await redeem()
    await refresh('connection-A', 'material-A', 7)
    await refresh('connection-A', 'material-A', 7)
    await refresh('connection-B', 'material-A', 7)
    await refresh('connection-A', 'material-B', 7)
    await refresh('connection-A', 'material-A', 8)
    await revoke()
    await revoke()

    const operationKeys = calls.map((call) => call.body.operationKey)
    expect(operationKeys).toEqual([
      '27efd3f4881ac97ffe9a3bf4ab32b63dbd757fcabc058df03ce2c71ee09efc88',
      '27efd3f4881ac97ffe9a3bf4ab32b63dbd757fcabc058df03ce2c71ee09efc88',
      '1694d46d739340ddf31f41e6504e396e55978babb42cc48484a32fbd8f97642b',
      '1694d46d739340ddf31f41e6504e396e55978babb42cc48484a32fbd8f97642b',
      '418cc1e22ca150716f237cfb1a8bc3caeb0c106e0da79a128cc8fc562f22c356',
      '16aba1e65384d0a3c527cc3bcd214204f89f6a3d24b1097a42cdbaa1bed5c9b8',
      '222202b0c7009765ca48185457a569794561b29752ac37771ca7929983afd239',
      'fbcd263de13555c054e6e531d35c940d92bd58c0a62a6531633778de31c5ad39',
      'fbcd263de13555c054e6e531d35c940d92bd58c0a62a6531633778de31c5ad39',
    ])
    expect(calls.filter((call) => call.path.endsWith('/redeem')).map((call) => call.body)).toEqual([
      {
        handle: 'h'.repeat(43),
        localFlowId: 'flow-123',
        operationKey: operationKeys[0],
      },
      {
        handle: 'h'.repeat(43),
        localFlowId: 'flow-123',
        operationKey: operationKeys[1],
      },
    ])
    expect(calls.filter((call) => call.path.endsWith('/refresh')).map((call) => call.body)).toEqual([
      {
        refreshToken: 'refresh',
        operationKey: operationKeys[2],
        connectionFingerprint: '073f518b36466ca19560f7eb7aad64a808d0355d1bd5268a891156d62bae4027',
      },
      {
        refreshToken: 'refresh',
        operationKey: operationKeys[3],
        connectionFingerprint: '073f518b36466ca19560f7eb7aad64a808d0355d1bd5268a891156d62bae4027',
      },
      {
        refreshToken: 'refresh',
        operationKey: operationKeys[4],
        connectionFingerprint: '3e227a7123db362d3a3c66cc57b80a67a4edaf7481257892409261927603f096',
      },
      {
        refreshToken: 'refresh',
        operationKey: operationKeys[5],
        connectionFingerprint: '073f518b36466ca19560f7eb7aad64a808d0355d1bd5268a891156d62bae4027',
      },
      {
        refreshToken: 'refresh',
        operationKey: operationKeys[6],
        connectionFingerprint: '073f518b36466ca19560f7eb7aad64a808d0355d1bd5268a891156d62bae4027',
      },
    ])
    expect(calls.filter((call) => call.path.endsWith('/revoke')).map((call) => call.body)).toEqual([
      { token: 'access', operationKey: operationKeys[7] },
      { token: 'access', operationKey: operationKeys[8] },
    ])
  })

  test('uses exact tenant-scoped broker endpoints and normalizes their responses', async () => {
    const { calls, transport } = harness()
    const flow = crypto.randomUUID()
    const started = await transport.authorizationUrl({
      providerKey: 'notion',
      localFlowId: flow,
      intent: 'connect',
      returnTo: '/settings',
    })
    const redeemed = await transport.completeAuthorization({
      providerKey: 'notion',
      localFlowId: flow,
      handle: 'h'.repeat(43),
    })
    const refreshed = await transport.refresh({
      providerKey: 'notion',
      connectionId: 'connection-id',
      materialRevision: 'material-revision',
      tokenRevision: 4,
      refreshToken: 'refresh',
    })
    await transport.revoke({ providerKey: 'notion', credentialRef: 'credential-ref', token: 'access-2' })

    expect(started).toMatchObject({ authorizationUrl: expect.any(String), expiresAt: expect.any(String) })
    expect(redeemed.tokens).toEqual({ accessToken: 'access', refreshToken: 'refresh', expiresAt: null })
    expect(refreshed).toMatchObject({
      tokens: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: null },
      configuration: { workspaceId: 'workspace' },
    })
    expect(calls.map((call) => call.path)).toEqual([
      '/api/oauth-broker/notion/start',
      '/api/oauth-broker/notion/redeem',
      '/api/oauth-broker/notion/refresh',
      '/api/oauth-broker/notion/revoke',
    ])
    expect(calls[1]!.body.operationKey).toBe(operationKey.redeem(flow))
    expect(calls[2]!.body).toMatchObject({
      operationKey: operationKey.refresh('connection-id', 'material-revision', 4),
      connectionFingerprint: operationKey.connectionFingerprint('connection-id'),
    })
    expect(calls[3]!.body.operationKey).toBe(operationKey.revoke('credential-ref'))
  })

  test('never sends a local authorization code through the broker redeem endpoint', async () => {
    const { calls, transport } = harness()
    await expect(
      transport.completeAuthorization({
        providerKey: 'notion',
        localFlowId: crypto.randomUUID(),
        code: 'provider-code-SENTINEL',
      })
    ).rejects.toMatchObject({ code: 'malformed_callback' })
    expect(JSON.stringify(calls)).not.toContain('provider-code-SENTINEL')
  })
})
