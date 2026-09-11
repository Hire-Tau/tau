import { test, expect } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, settings, squads, integrationConnections, integrationConnectionAssignments } from '../../db'
import { DbIntegrationConnectionRepository } from './db-connection-repository'
import {
  initializeGitHubDefault,
  globalIntegrationDefault,
  reconcileSquadIntegration,
  setGlobalIntegrationDefault,
  INTEGRATION_DEFAULT_PREFIX,
  INTEGRATION_SQUAD_PREFIX,
} from './scope-settings'
import { INTEGRATION_ENABLED_PREFIX } from './provider-state'

test('GitHub defaults inherit, overrides survive global changes, and pausing squad access preserves its choice', async () => {
  const keys = [INTEGRATION_DEFAULT_PREFIX + 'github', INTEGRATION_ENABLED_PREFIX + 'github']
  const previous = await db.select().from(settings).where(inArray(settings.key, keys))
  const ids = [crypto.randomUUID(), crypto.randomUUID()]
  const squadIds: string[] = []
  const repository = new DbIntegrationConnectionRepository()
  try {
    await db.delete(settings).where(inArray(settings.key, keys))
    await db.insert(settings).values({ key: keys[1], value: 'true' })
    // An earlier failed login must not become the default.
    for (const [i, id] of ids.entries()) {
      const revision = crypto.randomUUID()
      await db.insert(integrationConnections).values({
        id,
        providerKey: 'github',
        adapterVersion: 1,
        displayName: id,
        configuration: {},
        credentialRef: `test:${id}`,
        materialRevision: revision,
        validatedRevision: revision,
        enabled: true,
        authState: 'authenticated',
        healthState: 'healthy',
        validationExpiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(i),
      })
    }
    await initializeGitHubDefault()
    expect(await globalIntegrationDefault('github')).toBe(ids[0])
    for (let i = 0; i < 2; i++) {
      const [squad] = await db
        .insert(squads)
        .values({ name: `scope-${crypto.randomUUID()}`, purpose: 'test' })
        .returning()
      squadIds.push(squad.id)
      expect((await reconcileSquadIntegration(squad.id, 'github')).inheritDefault).toBe(true)
      expect((await repository.getAssigned(squad.id, 'github'))?.id).toBe(ids[0])
    }
    await repository.assign(squadIds[1], 'github', ids[0])
    await setGlobalIntegrationDefault('github', ids[1])
    expect((await repository.getAssigned(squadIds[0], 'github'))?.id).toBe(ids[1])
    expect((await repository.getAssigned(squadIds[1], 'github'))?.id).toBe(ids[0])
    await reconcileSquadIntegration(squadIds[0], 'github', { enabled: false })
    expect(await repository.getAssigned(squadIds[0], 'github')).toBeNull()
    await initializeGitHubDefault()
    expect(await globalIntegrationDefault('github')).toBe(ids[1])
    await reconcileSquadIntegration(squadIds[0], 'github', { enabled: true })
    expect((await repository.getAssigned(squadIds[0], 'github'))?.id).toBe(ids[1])
    await reconcileSquadIntegration(squadIds[1], 'github', { enabled: false })
    await reconcileSquadIntegration(squadIds[1], 'github', { enabled: true })
    expect((await repository.getAssigned(squadIds[1], 'github'))?.id).toBe(ids[0])
    await db.delete(integrationConnections).where(eq(integrationConnections.id, ids[1]))
    await initializeGitHubDefault()
    expect(await repository.getAssigned(squadIds[0], 'github')).toBeNull()
    expect(
      await db
        .select()
        .from(integrationConnectionAssignments)
        .where(eq(integrationConnectionAssignments.squadId, squadIds[0]))
    ).toHaveLength(0)
  } finally {
    if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, ids))
    await db
      .delete(settings)
      .where(inArray(settings.key, [...keys, ...squadIds.map((id) => `${INTEGRATION_SQUAD_PREFIX}github:${id}`)]))
    if (previous.length) await db.insert(settings).values(previous)
  }
})
