import { inArray } from 'drizzle-orm'
import { db, squads } from '../../db'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Squad } from '../../entities/Squad'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser } from '../../test-utils'
import { requireConsultantCreationAccess } from './consultant-access'

const prefix = `consultant-access-${crypto.randomUUID()}`
let allowed: Squad
let elsewhere: Squad
let userId: string
beforeAll(async () => {
  const user = await createTestUser({ prefix })
  userId = user.id
  allowed = await Squad.create({ name: `${prefix}-allowed`, purpose: 'fixture' })
  elsewhere = await Squad.create({ name: `${prefix}-elsewhere`, purpose: 'fixture' })
  const chatRole = await createTestRole({ prefix, permissions: ['chat:send'] })
  const readRole = await createTestRole({ prefix, permissions: ['squads:read', 'agents:read', 'workspace:read'] })
  await assignRole({ userId, roleId: chatRole.id, scope: 'squad', squadId: allowed.id })
  await assignRole({ userId, roleId: readRole.id, scope: 'squad', squadId: elsewhere.id })
})
afterAll(async () => {
  const ids = [allowed?.id, elsewhere?.id].filter((id): id is string => Boolean(id))
  if (ids.length) await db.delete(squads).where(inArray(squads.id, ids))
  await cleanupTestRbac(prefix)
})
test('consultant creation uses the target squad chat policy, not read access or another squad grant', async () => {
  const identity = { type: 'user' as const, userId }
  expect((await requireConsultantCreationAccess(identity, allowed.id)).id).toBe(allowed.id)
  await expect(requireConsultantCreationAccess(identity, elsewhere.id)).rejects.toThrow('Squad not found')
  await expect(requireConsultantCreationAccess(identity, crypto.randomUUID())).rejects.toThrow('Squad not found')
  await expect(requireConsultantCreationAccess(undefined, allowed.id)).rejects.toThrow('Squad not found')
})
test('archived squads cannot create consultants even with chat permission', async () => {
  await allowed.update({ status: 'archived' })
  try {
    await expect(requireConsultantCreationAccess({ type: 'user', userId }, allowed.id)).rejects.toThrow(
      'Squad not found'
    )
  } finally {
    await allowed.update({ status: 'active' })
  }
})
