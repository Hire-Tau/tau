import { expect, test } from 'bun:test'
import { serializeOAuthCredential } from './credential-bundle'
import { IntegrationRefreshWorker } from './refresh-worker'

test('refresh worker selects only documented non-null expiries inside the refresh window', async () => {
  const refreshed: string[] = []
  const values = new Map([
    [
      'null-expiry',
      serializeOAuthCredential({
        version: 1,
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: null,
        tokenRevision: 1,
      }),
    ],
    [
      'future-expiry',
      serializeOAuthCredential({
        version: 1,
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: '2026-08-29T02:00:00.000Z',
        tokenRevision: 1,
      }),
    ],
    [
      'due-expiry',
      serializeOAuthCredential({
        version: 1,
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: '2026-08-29T01:04:00.000Z',
        tokenRevision: 1,
      }),
    ],
  ])
  const worker = new IntegrationRefreshWorker({
    oauthProviderKeys: () => ['notion'],
    listConnections: async (_provider, _authority, _afterId, _limit, authorityFilter) =>
      authorityFilter === 'mismatched'
        ? []
        : [...values.keys()].map((id) => ({
            id,
            credentialRef: id,
            enabled: true,
            authState: 'authenticated' as const,
            clientAuthority: 'local' as const,
            materialRevision: `revision-${id}`,
          })),
    credentials: { get: (key) => values.get(key) },
    currentAuthority: () => 'local',
    refresh: async (id) => void refreshed.push(id),
    now: () => new Date('2026-08-29T01:00:00.000Z'),
    refreshWindowMs: 5 * 60_000,
  })

  expect(await worker.runOnce()).toBe(1)
  expect(refreshed).toEqual(['due-expiry'])
})

test('a failing mismatch cohort cannot starve the current-authority refresh budget', async () => {
  const due = serializeOAuthCredential({
    version: 1,
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: '2000-01-01T00:00:00.000Z',
    tokenRevision: 1,
  })
  const mismatchAttempts: string[] = []
  const currentRefreshes: string[] = []
  const worker = new IntegrationRefreshWorker({
    oauthProviderKeys: () => ['notion'],
    listConnections: async (_provider, _authority, _afterId, limit, filter) =>
      filter === 'mismatched'
        ? Array.from({ length: 50 }, (_, index) => ({
            id: `mismatch-${String(index).padStart(2, '0')}`,
            credentialRef: `mismatch-${index}`,
            enabled: true,
            authState: 'authenticated',
            clientAuthority: 'local' as const,
          })).slice(0, limit)
        : [
            {
              id: 'current-due',
              credentialRef: 'current-due',
              enabled: true,
              authState: 'authenticated',
              clientAuthority: 'platform_broker' as const,
            },
          ],
    credentials: { get: () => due },
    currentAuthority: () => 'platform_broker',
    refresh: async (id) => {
      if (id.startsWith('mismatch')) {
        mismatchAttempts.push(id)
        throw new Error('lease contended')
      }
      currentRefreshes.push(id)
    },
  })
  expect(await worker.runOnce()).toBe(1)
  expect(mismatchAttempts).toHaveLength(25)
  expect(currentRefreshes).toEqual(['current-due'])
})

test('refresh worker rotates stable batches and reconciles historical authority including null expiry', async () => {
  const connections = Array.from({ length: 101 }, (_, index) => ({
    id: String(index).padStart(3, '0'),
    credentialRef: `credential-${index}`,
    enabled: true,
    authState: 'authenticated',
    clientAuthority: index === 100 ? ('local' as const) : ('platform_broker' as const),
    materialRevision: `revision-${index}`,
  }))
  const refreshed: string[] = []
  const worker = new IntegrationRefreshWorker({
    oauthProviderKeys: () => ['notion'],
    listConnections: async (_provider, currentAuthority, afterId, limit, authorityFilter) =>
      [...connections]
        .filter((connection) => {
          const authorityMatches = connection.clientAuthority === currentAuthority
          return (
            connection.enabled &&
            connection.authState === 'authenticated' &&
            (authorityFilter === 'matching' ? authorityMatches : !authorityMatches) &&
            (!afterId || connection.id > afterId)
          )
        })
        .sort(
          (left, right) =>
            Number(left.clientAuthority === currentAuthority) - Number(right.clientAuthority === currentAuthority) ||
            left.id.localeCompare(right.id)
        )
        .slice(0, limit),
    credentials: {
      get: (key) =>
        serializeOAuthCredential({
          version: 1,
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: key === 'credential-99' ? '2000-01-01T00:00:00.000Z' : null,
          tokenRevision: 1,
        }),
    },
    currentAuthority: () => 'platform_broker',
    refresh: async (id) => {
      refreshed.push(id)
      const connection = connections.find((candidate) => candidate.id === id)
      if (connection?.id === '100') connection.authState = 'reauthorization_required'
    },
  })
  await worker.runOnce()
  await worker.runOnce()
  await worker.runOnce()
  await worker.runOnce()
  await worker.runOnce()
  expect(refreshed).toEqual(['100', '099'])
})
