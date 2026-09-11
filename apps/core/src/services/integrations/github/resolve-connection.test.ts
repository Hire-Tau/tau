import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, squads, integrationConnections } from '../../../db'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import {
  resolveGitHubConnection,
  resolveGitHubRelayAssignment,
  resolveInstanceGitHubConnection,
} from './resolve-connection'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { getSecretStore } from '../../secrets'
import { serializeOAuthCredential, rotateOAuthCredential } from '../authorization/credential-bundle'

test('instance updater resolves an encrypted connection without a squad and honors explicit account selection', async () => {
  const first = await createTestGitHubConnection({ login: 'updater' })
  const second = await createTestGitHubConnection({ login: 'other-account' })
  try {
    expect(await resolveInstanceGitHubConnection()).toBeUndefined()
    expect((await resolveInstanceGitHubConnection(first.id))?.credential.accessToken).toBe(`test-access-${first.id}`)
    expect((await resolveInstanceGitHubConnection(second.id))?.connection.id).toBe(second.id)
    await db.update(integrationConnections).set({ enabled: false }).where(eq(integrationConnections.id, first.id))
    expect(await resolveInstanceGitHubConnection(first.id)).toBeUndefined()
    expect((await resolveInstanceGitHubConnection())?.connection.id).toBe(second.id)
  } finally {
    await first.dispose()
    await second.dispose()
  }
})

test('multiple accounts remain attached when the default changes, and explicit selection cannot cross squads', async () => {
  const squadId = crypto.randomUUID(),
    otherId = crypto.randomUUID()
  await db.insert(squads).values([
    { id: squadId, name: 'Connections', purpose: 'test' },
    { id: otherId, name: 'Other', purpose: 'test' },
  ])
  const fixtures: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
  try {
    const first = await createTestGitHubConnection({ squadId, login: 'work' })
    fixtures.push(first)
    const second = await createTestGitHubConnection({ squadId, login: 'personal', isDefault: false })
    fixtures.push(second)
    expect((await resolveGitHubConnection(squadId))?.connection.id).toBe(first.id)
    expect((await resolveGitHubConnection(squadId, second.id))?.configuration.login).toBe('personal')
    expect(await resolveGitHubConnection(otherId, first.id)).toBeUndefined()
    const repository = new DbIntegrationConnectionRepository()
    await repository.assign(squadId, 'github', second.id, undefined, { retainPrevious: true })
    expect((await repository.listAssigned(squadId, 'github')).map((item) => item.id).sort()).toEqual(
      [first.id, second.id].sort()
    )
    expect((await resolveGitHubConnection(squadId))?.connection.id).toBe(second.id)
    await repository.unassign(squadId, 'github', undefined, second.id)
    expect(await resolveGitHubConnection(squadId)).toBeUndefined()
    expect(await resolveGitHubConnection(squadId, second.id)).toBeUndefined()
    expect((await resolveGitHubConnection(squadId, first.id))?.connection.id).toBe(first.id)
  } finally {
    for (const fixture of fixtures) await fixture.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(squads).where(eq(squads.id, otherId))
  }
})

test('each invocation observes token rotation and refuses disabled or expired authorization', async () => {
  const squadId = crypto.randomUUID()
  await db.insert(squads).values({ id: squadId, name: 'Rotation', purpose: 'test' })
  const fixture = await createTestGitHubConnection({ squadId })
  try {
    const store = getSecretStore()
    const before = (await resolveGitHubConnection(squadId))!.credential
    await store.set(
      fixture.credentialRef,
      serializeOAuthCredential(
        rotateOAuthCredential(before, {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      ),
      'test'
    )
    expect((await resolveGitHubConnection(squadId))?.credential.accessToken).toBe('new-access')
    await db.update(integrationConnections).set({ enabled: false }).where(eq(integrationConnections.id, fixture.id))
    expect(await resolveGitHubConnection(squadId)).toBeUndefined()
    await db
      .update(integrationConnections)
      .set({ enabled: true, validationExpiresAt: new Date(0) })
      .where(eq(integrationConnections.id, fixture.id))
    expect(await resolveGitHubConnection(squadId)).toBeUndefined()
  } finally {
    await fixture.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})

test('relay retains its queued delivery across validation expiry without using stale credentials', async () => {
  const { discoverGitHubRelayInterests } = await import('../relay/github-interests')
  const { HostedIntegrationRelayRunner } = await import('../relay/runner')
  const { dispatchHostedGitHubDelivery } = await import('../relay/runtime')
  const squadId = crypto.randomUUID()
  await db.insert(squads).values({ id: squadId, name: 'Relay validation gap', purpose: 'test' })
  const fixture = await createTestGitHubConnection({ squadId })
  try {
    const current = (await resolveInstanceGitHubConnection(fixture.id))!
    const revision = current.connection.materialRevision
    const event = {
      id: crypto.randomUUID(),
      leaseToken: crypto.randomUUID(),
      connectionId: fixture.id,
      connectionRevision: revision,
      deliveryId: crypto.randomUUID(),
      resourceId: '12',
      resourceKey: 'org/repo',
      eventType: 'issues',
      payload: {},
    }
    const calls: string[] = [],
      dispatched: string[] = []
    let queued = true,
      now = 0
    const runner = new HostedIntegrationRelayRunner({
      managed: () => true,
      interests: () =>
        discoverGitHubRelayInterests({
          listWorkStreams: async () => [],
          listSquads: async () => [{ id: squadId, metadata: { github: [{ repo: 'org/repo' }] } }],
          resolveConnection: resolveGitHubRelayAssignment,
        }),
      resolve: async (id) => {
        const live = await resolveInstanceGitHubConnection(id)
        return live && { id, revision: live.connection.materialRevision, accessToken: live.credential.accessToken }
      },
      request: async (input) => {
        const path = input.path.split('/').at(-1)!
        calls.push(path)
        if (path === 'status')
          return input.schema.parse({
            enabled: true,
            connections: [{ connectionId: fixture.id, connectionRevision: revision }],
          })
        if (path === 'unsubscribe' || path === 'ack') queued = false
        if (path === 'pull') return input.schema.parse({ deliveries: queued ? [event] : [] })
        return input.schema.parse({ ok: true })
      },
      dispatch: async (delivery) => {
        dispatched.push(delivery.id)
      },
      now: () => now,
      onError: (code) => {
        throw new Error(code)
      },
    })
    await db
      .update(integrationConnections)
      .set({ validationExpiresAt: new Date(0) })
      .where(eq(integrationConnections.id, fixture.id))
    expect(await resolveGitHubRelayAssignment(squadId)).toEqual({ id: fixture.id })
    expect(await resolveGitHubConnection(squadId)).toBeUndefined()
    await expect(
      dispatchHostedGitHubDelivery(event, [{ squadId, connectionId: fixture.id, repository: 'org/repo' }])
    ).rejects.toThrow('relay_authorization_unavailable')
    await runner.tick()
    now += 300_000
    await runner.tick()
    expect(calls).toEqual(['status', 'status'])
    expect(queued).toBe(true)
    expect(dispatched).toEqual([])
    await db
      .update(integrationConnections)
      .set({ validationExpiresAt: new Date(Date.now() + 900_000) })
      .where(eq(integrationConnections.id, fixture.id))
    await runner.tick()
    expect(calls.slice(-3)).toEqual(['subscribe', 'pull', 'ack'])
    expect(dispatched).toEqual([event.id])
    expect(queued).toBe(false)
    await runner.stop()
  } finally {
    await fixture.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})

test('relay assignment identity still rejects disabled, invalid, mismatched and detached connections', async () => {
  const squadId = crypto.randomUUID()
  await db.insert(squads).values({ id: squadId, name: 'Relay assignment authority', purpose: 'test' })
  const fixture = await createTestGitHubConnection({ squadId })
  try {
    const current = (await resolveInstanceGitHubConnection(fixture.id))!.connection
    const cases = [
      { enabled: false },
      { authState: 'invalid' as const },
      { authState: 'reauthorization_required' as const },
      { healthState: 'degraded' as const },
      { materialRevision: crypto.randomUUID() },
    ]
    for (const patch of cases) {
      await db.update(integrationConnections).set(patch).where(eq(integrationConnections.id, fixture.id))
      expect(await resolveGitHubRelayAssignment(squadId, fixture.id)).toBeUndefined()
      await db
        .update(integrationConnections)
        .set({
          enabled: true,
          authState: 'authenticated',
          healthState: 'healthy',
          materialRevision: current.materialRevision,
        })
        .where(eq(integrationConnections.id, fixture.id))
    }
    expect(await resolveGitHubRelayAssignment(crypto.randomUUID(), fixture.id)).toBeUndefined()
    expect(await resolveGitHubRelayAssignment(squadId, crypto.randomUUID())).toBeUndefined()
    await new DbIntegrationConnectionRepository().unassign(squadId, 'github', undefined, fixture.id)
    expect(await resolveGitHubRelayAssignment(squadId, fixture.id)).toBeUndefined()
  } finally {
    await fixture.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
  }
})
