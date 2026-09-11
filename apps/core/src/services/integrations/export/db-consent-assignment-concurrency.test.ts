import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('bigbrain')
import { expect, test } from 'bun:test'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { agents, db, integrationConnections, integrationExportConsents, squads, users } from '../../../db'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { DbExportConsentRepository } from './db-consent-repository'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

async function createEnabled(repository: DbIntegrationConnectionRepository) {
  const id = crypto.randomUUID()
  const connection = await repository.createPending({
    id,
    providerKey: 'bigbrain',
    adapterVersion: 1,
    displayName: `Consent race ${id}`,
    configuration: { version: 1, apiBase: 'https://brain.example' },
    credentialRef: `test:${id}`,
    materialRevision: crypto.randomUUID(),
  })
  await repository.enableValidated({
    id,
    materialRevision: connection.materialRevision,
    validation: { ok: true, grantedScopes: ['inbox:write'] },
    now: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })
  return connection
}

async function fixture() {
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Consent race ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com` })
    .returning()
  const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
  const [first, second] = await Promise.all([createEnabled(repository), createEnabled(repository)])
  await repository.assign(squad.id, 'bigbrain', first.id)
  const input = {
    squadId: squad.id,
    connectionId: first.id,
    agentId: agent.id,
    consentedByUserId: user.id,
    policyVersion: 1 as const,
    projectionVersion: 1 as const,
    adoptedEnqueueOrder: 0n,
  }
  const cleanup = async () => {
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, [first.id, second.id]))
    await db.delete(users).where(eq(users.id, user.id))
  }
  return { squad, agent, first, second, input, cleanup }
}

for (const operation of ['switch', 'unassign'] as const) {
  test(`consent created first is revoked by a following assignment ${operation}`, async () => {
    const value = await fixture()
    const locked = deferred()
    const release = deferred()
    const consentRepository = new DbExportConsentRepository({
      afterSquadLock: async () => {
        locked.resolve()
        await release.promise
      },
    })
    try {
      const consentPromise = consentRepository.createWithCursor(value.input)
      await locked.promise
      const repository = new DbIntegrationConnectionRepository()
      let mutationSettled = false
      const mutationPromise = (
        operation === 'switch'
          ? repository.assign(value.squad.id, 'bigbrain', value.second.id)
          : repository.unassign(value.squad.id, 'bigbrain')
      ).finally(() => (mutationSettled = true))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(mutationSettled).toBe(false)
      release.resolve()
      const consent = await consentPromise
      await mutationPromise
      const [after] = await db
        .select()
        .from(integrationExportConsents)
        .where(eq(integrationExportConsents.id, consent.id))
      expect(after?.revokedAt).toBeInstanceOf(Date)
      expect(
        await db
          .select()
          .from(integrationExportConsents)
          .where(
            and(eq(integrationExportConsents.agentId, value.agent.id), isNull(integrationExportConsents.revokedAt))
          )
      ).toHaveLength(0)
    } finally {
      release.resolve()
      await value.cleanup()
    }
  })

  test(`assignment ${operation} first makes a delayed consent fail without inserting a cursor`, async () => {
    const value = await fixture()
    const locked = deferred()
    const release = deferred()
    const repository = new DbIntegrationConnectionRepository({
      afterSquadLock: async () => {
        locked.resolve()
        await release.promise
      },
    })
    try {
      const mutationPromise =
        operation === 'switch'
          ? repository.assign(value.squad.id, 'bigbrain', value.second.id)
          : repository.unassign(value.squad.id, 'bigbrain')
      await locked.promise
      const consentRepository = new DbExportConsentRepository()
      const consentPromise = consentRepository.createWithCursor(value.input)
      release.resolve()
      await mutationPromise
      await expect(consentPromise).rejects.toThrow('Integration assignment changed')
      expect(
        await db.select().from(integrationExportConsents).where(eq(integrationExportConsents.agentId, value.agent.id))
      ).toHaveLength(0)
    } finally {
      release.resolve()
      await value.cleanup()
    }
  })
}
