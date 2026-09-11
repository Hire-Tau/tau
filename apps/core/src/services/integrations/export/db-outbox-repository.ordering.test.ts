import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  agents,
  db,
  integrationConnections,
  integrationExportBatches,
  integrationExportConsents,
  integrationExportCursors,
  squads,
  users,
} from '../../../db'
import { DbExportOutboxRepository } from './db-outbox-repository'

const ids: { squad?: string; user?: string } = {}

// claimNext works the GLOBAL pending queue, so a pending batch leaked by any
// earlier test file wins the claim and breaks this file's identity assertions
// (observed twice in CI full-suite runs). Files run sequentially, so clearing
// the table here only ever removes other files' leftovers.
beforeEach(async () => {
  await db.delete(integrationExportBatches)
})

afterEach(async () => {
  if (ids.squad) await db.delete(squads).where(eq(squads.id, ids.squad))
  if (ids.user) await db.delete(users).where(eq(users.id, ids.user))
  ids.squad = undefined
  ids.user = undefined
})

async function createCursor(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `outbox-${crypto.randomUUID()}@example.test` })
    .returning()
  const [squad] = await db.insert(squads).values({ name: 'Ordered export queue', purpose: 'test' }).returning()
  ids.user = user.id
  ids.squad = squad.id
  const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
  const [connection] = await db
    .insert(integrationConnections)
    .values({
      squadId: squad.id,
      providerKey: 'bigbrain',
      adapterVersion: 1,
      displayName: 'Brain',
      configuration: { version: 1, apiBase: 'https://brain.example' },
      credentialRef: 'test:credential',
    })
    .returning()
  const [consent] = await db
    .insert(integrationExportConsents)
    .values({
      connectionId: connection.id,
      agentId: agent.id,
      consentedByUserId: user.id,
      adoptedEnqueueOrder: 0n,
    })
    .returning()
  const [cursor] = await db
    .insert(integrationExportCursors)
    .values({ consentId: consent.id, lastDeliveredEnqueueOrder: 0n })
    .returning()
  return cursor.id
}

test('durably queues later completions while an earlier retry blocks their delivery', async () => {
  const repository = new DbExportOutboxRepository()
  const cursorId = await createCursor()
  const now = new Date(Date.now() + 1_000)
  const create = (firstEnqueueOrder: bigint) =>
    repository.createBatch({
      id: crypto.randomUUID(),
      cursorId,
      idempotencyKey: crypto.randomUUID(),
      firstEnqueueOrder,
      lastEnqueueOrder: firstEnqueueOrder,
      recordCount: 1,
      byteCount: 10,
      encryptedPayload: `encrypted-${firstEnqueueOrder}`,
      payloadIv: `iv-${firstEnqueueOrder}`,
      now,
    })

  const first = await create(10n)
  const duplicate = await create(10n)
  const second = await create(20n)
  expect(first).not.toBeNull()
  expect(duplicate).toBeNull()
  expect(second).not.toBeNull()
  expect(
    await db.select().from(integrationExportBatches).where(eq(integrationExportBatches.cursorId, cursorId))
  ).toHaveLength(2)

  const leaseToken = crypto.randomUUID()
  const claimed = await repository.claimNext({ now, leaseToken, leaseExpiresAt: new Date(now.getTime() + 60_000) })
  expect(claimed?.id).toBe(first?.id)
  await repository.markRetry({
    batchId: first!.id,
    leaseToken,
    nextAttemptAt: new Date(now.getTime() + 60_000),
    code: 'retry',
  })

  expect(
    await repository.claimNext({
      now,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    })
  ).toBeNull()
})
