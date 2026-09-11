import { expect, test } from 'bun:test'
import { serializeOAuthCredential } from '../authorization/credential-bundle'
import { discoverProjectionCredentialDrift } from './credential-drift'

test('one unreadable credential does not block drift repair for another ready projection', async () => {
  const invalidated: string[] = []
  await discoverProjectionCredentialDrift({
    states: {
      listReady: async () => [
        { squadId: 'broken', providerKey: 'notion', appliedCredentialRevision: 1n } as any,
        { squadId: 'healthy', providerKey: 'notion', appliedCredentialRevision: 1n } as any,
      ],
      invalidate: async (input) => {
        invalidated.push(input.squadId)
        return {} as any
      },
    },
    connections: {
      getAssigned: async (squadId) => {
        if (squadId === 'broken') throw new Error('secret backend unavailable')
        return { credentialRef: 'credential-2' } as any
      },
    },
    credential: () =>
      serializeOAuthCredential({
        version: 1,
        accessToken: 'two',
        refreshToken: 'refresh',
        expiresAt: null,
        tokenRevision: 2,
      }),
    now: new Date(),
  })
  expect(invalidated).toEqual(['healthy'])
})

test('ready revision one is durably invalidated when encrypted material rotated to revision two without an event', async () => {
  const invalidations: unknown[] = []
  await discoverProjectionCredentialDrift({
    states: {
      listReady: async () => [
        {
          squadId: 'squad-1',
          providerKey: 'notion',
          appliedCredentialRevision: 1n,
        } as any,
      ],
      invalidate: async (input) => {
        invalidations.push(input)
        return {} as any
      },
    },
    connections: {
      getAssigned: async () => ({ credentialRef: 'credential-1' }) as any,
    },
    credential: () =>
      serializeOAuthCredential({
        version: 1,
        accessToken: 'access-two',
        refreshToken: 'refresh-two',
        expiresAt: null,
        tokenRevision: 2,
      }),
    now: new Date('2026-08-29T08:00:00.000Z'),
  })
  expect(invalidations).toEqual([
    {
      squadId: 'squad-1',
      providerKey: 'notion',
      credentialRevision: 2n,
      now: new Date('2026-08-29T08:00:00.000Z'),
    },
  ])
})
