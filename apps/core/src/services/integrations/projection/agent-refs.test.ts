import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('notion')
import { INTEGRATION_ENABLED_PREFIX, setIntegrationEnabled } from '../provider-state'
import { loadEffectiveToolchain } from './load-effective-toolchain'
import { loadProtectedIntegrationBindings } from './protected-env'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, integrationConnections, secrets, settings, squads } from '../../../db'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { mergeAgentRefs, resolveAssignedIntegrationRefs } from './agent-refs'

test('assigned integration refs are deterministic for every agent type and disappear on global disable or unassignment', async () => {
  const key = INTEGRATION_ENABLED_PREFIX + 'notion'
  const [previous] = await db.select().from(settings).where(eq(settings.key, key))
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Refs ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const id = crypto.randomUUID()
  const credentialRef = `test:${crypto.randomUUID()}`
  const revision = crypto.randomUUID()
  await db.insert(secrets).values({ key: credentialRef, encryptedValue: 'ciphertext', iv: 'iv' })
  await repository.createPending({
    id,
    providerKey: 'notion',
    adapterVersion: 1,
    displayName: 'Workspace',
    configuration: { version: 1, workspaceId: 'workspace', workspaceName: null, workspaceIcon: null, botId: 'bot' },
    credentialRef,
    materialRevision: revision,
  })
  await repository.enableValidated({
    id,
    materialRevision: revision,
    validation: { ok: true, grantedScopes: [] },
    now: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })
  try {
    await repository.assign(squad.id, 'notion', id)
    expect(await resolveAssignedIntegrationRefs(squad.id)).toEqual({ skills: ['notion'], extensions: [] })
    const toolchain = await loadEffectiveToolchain(squad.id, undefined)
    await setIntegrationEnabled('notion', false, 'test')
    expect(await resolveAssignedIntegrationRefs(squad.id)).toEqual({ skills: [], extensions: [] })
    expect(await loadProtectedIntegrationBindings(squad.id)).toEqual([])
    expect((await loadEffectiveToolchain(squad.id, undefined)).integrationFingerprint).not.toBe(
      toolchain.integrationFingerprint
    )
    await setIntegrationEnabled('notion', true, 'test')
    expect(await resolveAssignedIntegrationRefs(squad.id)).toEqual({ skills: ['notion'], extensions: [] })
    expect(mergeAgentRefs(['type-skill'], ['squad-skill'], ['notion'])).toEqual(['type-skill', 'squad-skill', 'notion'])
    await repository.unassign(squad.id, 'notion')
    expect(await resolveAssignedIntegrationRefs(squad.id)).toEqual({ skills: [], extensions: [] })
  } finally {
    if (previous) await db.update(settings).set(previous).where(eq(settings.key, key))
    else await db.delete(settings).where(eq(settings.key, key))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
    await db.delete(secrets).where(eq(secrets.key, credentialRef))
    await db.delete(squads).where(eq(squads.id, squad.id))
  }
})
