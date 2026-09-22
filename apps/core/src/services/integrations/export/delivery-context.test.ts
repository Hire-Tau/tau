import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('bigbrain')
import { INTEGRATION_ENABLED_PREFIX, setIntegrationEnabled } from '../provider-state'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  agents,
  agentTypes,
  db,
  integrationConnectionAssignments,
  integrationConnections,
  integrationExportBatches,
  integrationExportConsents,
  integrationExportCursors,
  squads,
  settings,
  users,
} from '../../../db'
import { isSupportedExportDeliveryState, resolveExportDeliveryDecision } from './delivery-context'

const supported = {
  connection: {
    providerKey: 'bigbrain',
    adapterVersion: 1,
    configuration: { version: 1, apiBase: 'https://brain.example' },
  },
  consent: { policyVersion: 1, projectionVersion: 1 },
}

test.each([
  ['provider', { connection: { ...supported.connection, providerKey: 'unknown' }, consent: supported.consent }],
  ['adapter', { connection: { ...supported.connection, adapterVersion: 2 }, consent: supported.consent }],
  [
    'config',
    {
      connection: { ...supported.connection, configuration: { version: 2, apiBase: 'https://brain.example' } },
      consent: supported.consent,
    },
  ],
  ['consent policy', { connection: supported.connection, consent: { ...supported.consent, policyVersion: 2 } }],
  ['projection', { connection: supported.connection, consent: { ...supported.consent, projectionVersion: 2 } }],
] as const)('fails closed for unsupported %s version before delivery', (_name, state) => {
  expect(isSupportedExportDeliveryState(state)).toBe(false)
})

test('accepts only the current delivery contract', () => {
  expect(isSupportedExportDeliveryState(supported)).toBe(true)
})

test('delivery remains eligible only while consent matches the current squad assignment', async () => {
  const key = INTEGRATION_ENABLED_PREFIX + 'bigbrain'
  const [previous] = await db.select().from(settings).where(eq(settings.key, key))
  const suffix = crypto.randomUUID()
  const agentTypeId = `export-${suffix}`
  const [squad] = await db
    .insert(squads)
    .values({ name: `Export ${suffix}`, purpose: 'test' })
    .returning()
  const [user] = await db
    .insert(users)
    .values({ email: `export-${suffix}@example.com` })
    .returning()
  await db.insert(agentTypes).values({
    id: agentTypeId,
    name: 'Export test',
    model: 'test',
    systemPrompt: 'test',
    integrationCapabilities: { version: 1, allow: { bigbrain: ['conversation_export'] } },
  })
  const [agent] = await db.insert(agents).values({ agentTypeId, squadId: squad.id }).returning()
  const materialRevision = crypto.randomUUID()
  const future = new Date(Date.now() + 60_000)
  const createConnection = (name: string) =>
    db
      .insert(integrationConnections)
      .values({
        providerKey: 'bigbrain',
        adapterVersion: 1,
        displayName: `${name} ${suffix}`,
        configuration: { version: 1, apiBase: 'https://brain.example' },
        credentialRef: `test:${name}:${suffix}`,
        enabled: true,
        authState: 'authenticated',
        healthState: 'healthy',
        grantedScopes: ['inbox:write'],
        materialRevision,
        validatedRevision: materialRevision,
        validationExpiresAt: future,
      })
      .returning()
  const [first] = await createConnection('first')
  const [second] = await createConnection('second')
  const [consent] = await db
    .insert(integrationExportConsents)
    .values({ connectionId: first.id, agentId: agent.id, consentedByUserId: user.id, adoptedEnqueueOrder: 0n })
    .returning()
  const [cursor] = await db
    .insert(integrationExportCursors)
    .values({ consentId: consent.id, lastDeliveredEnqueueOrder: 0n })
    .returning()
  const [batch] = await db
    .insert(integrationExportBatches)
    .values({ cursorId: cursor.id, firstEnqueueOrder: 1n, lastEnqueueOrder: 1n, recordCount: 1, byteCount: 1 })
    .returning()
  try {
    await db
      .insert(integrationConnectionAssignments)
      .values({ squadId: squad.id, providerKey: 'bigbrain', connectionId: first.id })
    expect(await resolveExportDeliveryDecision(batch)).toMatchObject({ allowed: true })
    await setIntegrationEnabled('bigbrain', false, 'test')
    expect(await resolveExportDeliveryDecision(batch)).toMatchObject({
      allowed: false,
      code: 'connection_disabled',
      permanent: false,
    })
    await setIntegrationEnabled('bigbrain', true, 'test')
    expect(await resolveExportDeliveryDecision(batch)).toMatchObject({ allowed: true })

    await db
      .update(integrationConnectionAssignments)
      .set({ connectionId: second.id })
      .where(eq(integrationConnectionAssignments.squadId, squad.id))
    expect(await resolveExportDeliveryDecision(batch)).toMatchObject({
      allowed: false,
      code: 'assignment_changed',
      permanent: true,
    })

    await db.delete(integrationConnectionAssignments).where(eq(integrationConnectionAssignments.squadId, squad.id))
    expect(await resolveExportDeliveryDecision(batch)).toMatchObject({
      allowed: false,
      code: 'assignment_changed',
      permanent: true,
    })

    await db
      .insert(integrationConnectionAssignments)
      .values({ squadId: squad.id, providerKey: 'bigbrain', connectionId: first.id })
    await db.update(integrationConnections).set({ enabled: false }).where(eq(integrationConnections.id, first.id))
    expect(await resolveExportDeliveryDecision(batch)).toMatchObject({
      allowed: false,
      code: 'connection_disabled',
      permanent: false,
    })
  } finally {
    if (previous) await db.update(settings).set(previous).where(eq(settings.key, key))
    else await db.delete(settings).where(eq(settings.key, key))
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationExportConsents).where(eq(integrationExportConsents.consentedByUserId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, first.id))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, second.id))
  }
})
