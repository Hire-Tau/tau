import { describe, expect, test } from 'bun:test'
import { serializeOAuthCredential } from './credential-bundle'
import { IntegrationRevocationWorker, type IntegrationRevocationRepository } from './revocation-worker'
import { OAuthTransportError } from './transport'
import { PlatformRequestError } from '../../platform/instance-client'

function createHarness(error?: Error) {
  const job = {
    id: 'job-1',
    providerKey: 'notion',
    adapterVersion: 1,
    clientAuthority: 'local' as const,
    credentialRef: '__integration-credential:test',
    authorizationFlowId: null,
    attempts: 0,
    leaseToken: 'lease-1',
  }
  const completed: string[] = []
  const failed: Array<{ code: string; attempts: number }> = []
  const cleanup: string[] = []
  const audits: unknown[] = []
  const revokeCalls: Array<{ providerKey: string; credentialRef: string; token: string }> = []
  let claimed = false
  const repository: IntegrationRevocationRepository = {
    claim: async () => {
      if (claimed) return null
      claimed = true
      return job
    },
    complete: async (claimed) => {
      completed.push(claimed.id)
      cleanup.push(claimed.credentialRef)
    },
    fail: async (input) => void failed.push({ code: input.code, attempts: input.attempts }),
    failTerminal: async (input) => void failed.push({ code: input.code, attempts: input.attempts }),
  }
  const worker = new IntegrationRevocationWorker({
    repository,
    credentials: {
      refreshKey: async () => undefined,
      get: () =>
        serializeOAuthCredential({
          version: 1,
          accessToken: 'access-TOKEN-SENTINEL',
          refreshToken: 'refresh-TOKEN-SENTINEL',
          expiresAt: null,
          tokenRevision: 1,
        }),
    },
    resolvePlugin: () => ({
      authorization: { kind: 'oauth2', adapter: 'notion' },
      classifyError: (value: unknown) =>
        value instanceof Error && value.message === 'invalid_grant'
          ? { code: 'invalid_grant', retryable: false }
          : { code: 'provider_unavailable', retryable: true },
    }),
    revocationTransports: {
      resolve: () => ({
        authority: 'local',
        revoke: async (input) => {
          revokeCalls.push(input)
          if (error) throw error
        },
      }),
    },
    audit: { record: async (event) => void audits.push(event) },
    uuid: () => 'lease-1',
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  })
  return { worker, completed, failed, cleanup, audits, revokeCalls }
}

describe('IntegrationRevocationWorker', () => {
  test('revokes remotely before scheduling local credential cleanup', async () => {
    const harness = createHarness()
    expect(await harness.worker.runOnce()).toBe(true)
    expect(harness.cleanup).toEqual(['__integration-credential:test'])
    expect(harness.completed).toEqual(['job-1'])
    expect(harness.failed).toEqual([])
    expect(harness.revokeCalls).toEqual([
      {
        providerKey: 'notion',
        credentialRef: '__integration-credential:test',
        token: 'access-TOKEN-SENTINEL',
      },
    ])
    expect(JSON.stringify(harness.audits)).not.toContain('TOKEN-SENTINEL')
  })

  test('missing local client credentials retain the job with oauth_app_unconfigured', async () => {
    const harness = createHarness(new OAuthTransportError('oauth_app_unconfigured'))
    expect(await harness.worker.runOnce()).toBe(true)
    expect(harness.cleanup).toEqual([])
    expect(harness.completed).toEqual([])
    expect(harness.failed).toEqual([{ code: 'oauth_app_unconfigured', attempts: 1 }])
  })

  test('transient provider failure retains the job and secret for backoff', async () => {
    const harness = createHarness(new Error('raw provider body TOKEN-SENTINEL'))
    expect(await harness.worker.runOnce()).toBe(true)
    expect(harness.cleanup).toEqual([])
    expect(harness.completed).toEqual([])
    expect(harness.failed).toEqual([{ code: 'provider_unavailable', attempts: 1 }])
    expect(JSON.stringify(harness.audits)).not.toContain('TOKEN-SENTINEL')
  })

  test('a nonretryable terminal broker outcome completes and cleans up without leaking tokens', async () => {
    const harness = createHarness(new PlatformRequestError('already_revoked', false, 409))
    expect(await harness.worker.runOnce()).toBe(true)
    expect(harness.cleanup).toEqual(['__integration-credential:test'])
    expect(harness.completed).toEqual(['job-1'])
    expect(harness.failed).toEqual([])
    expect(harness.audits).toEqual([expect.objectContaining({ outcome: 'succeeded', code: 'already_revoked' })])
    expect(JSON.stringify(harness.audits)).not.toContain('TOKEN-SENTINEL')
  })

  test('a retryable broker outcome retains the job and credential with its safe code', async () => {
    const harness = createHarness(new PlatformRequestError('broker_unavailable', true, 503))
    expect(await harness.worker.runOnce()).toBe(true)
    expect(harness.cleanup).toEqual([])
    expect(harness.completed).toEqual([])
    expect(harness.failed).toEqual([{ code: 'broker_unavailable', attempts: 1 }])
    expect(harness.audits).toEqual([expect.objectContaining({ outcome: 'failed', code: 'broker_unavailable' })])
    expect(JSON.stringify(harness.audits)).not.toContain('TOKEN-SENTINEL')
  })

  test.each(['invalid_grant', 'invalid_auth', 'already_revoked'])(
    'retryable broker %s body retains the revocation job and credential',
    async (code) => {
      const harness = createHarness(new PlatformRequestError(code, true, 503))
      expect(await harness.worker.runOnce()).toBe(true)
      expect(harness.cleanup).toEqual([])
      expect(harness.completed).toEqual([])
      expect(harness.failed).toEqual([{ code, attempts: 1 }])
    }
  )

  test('routes revocation by persisted job authority rather than current deployment authority', async () => {
    let brokerCalls = 0
    let localCalls = 0
    let completed = false
    const repository: IntegrationRevocationRepository = {
      claim: async () => ({
        id: 'job-cross-authority',
        providerKey: 'notion',
        adapterVersion: 1,
        clientAuthority: 'platform_broker',
        credentialRef: '__integration-credential:historical',
        authorizationFlowId: null,
        attempts: 0,
        leaseToken: 'lease-cross-authority',
      }),
      complete: async () => void (completed = true),
      fail: async () => undefined,
      failTerminal: async () => undefined,
    }
    const worker = new IntegrationRevocationWorker({
      repository,
      credentials: {
        refreshKey: async () => undefined,
        get: () =>
          serializeOAuthCredential({
            version: 1,
            accessToken: 'historical-access',
            refreshToken: null,
            expiresAt: null,
            tokenRevision: 1,
          }),
      },
      resolvePlugin: () => ({
        authorization: { kind: 'oauth2', adapter: 'notion' },
        classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
      }),
      revocationTransports: {
        resolve: (authority) => ({
          authority,
          revoke: async () => {
            if (authority === 'platform_broker') brokerCalls += 1
            else localCalls += 1
          },
        }),
      },
    })

    expect(await worker.runOnce()).toBe(true)
    expect(brokerCalls).toBe(1)
    expect(localCalls).toBe(0)
    expect(completed).toBe(true)
  })

  test('already-invalid credentials are terminal success and proceed to cleanup', async () => {
    const harness = createHarness(new Error('invalid_grant'))
    expect(await harness.worker.runOnce()).toBe(true)
    expect(harness.cleanup).toEqual(['__integration-credential:test'])
    expect(harness.completed).toEqual(['job-1'])
  })
})
