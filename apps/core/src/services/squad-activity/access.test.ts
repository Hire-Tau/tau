import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { roleAssignments, roles, squads, systemTokens, users } from '../../db/schema'
import { resolveSquadActivityAccess } from './access'

const squadIds: string[] = []
const roleIds: string[] = []
const userIds: string[] = []
const systemTokenIds: string[] = []
afterEach(async () => {
  for (const id of systemTokenIds.splice(0)) await db.delete(systemTokens).where(eq(systemTokens.id, id))
  for (const id of userIds.splice(0)) {
    await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, id))
    await db.delete(users).where(eq(users.id, id))
  }
  for (const id of roleIds.splice(0)) await db.delete(roles).where(eq(roles.id, id))
  for (const id of squadIds.splice(0)) await db.delete(squads).where(eq(squads.id, id))
})

async function createSquad(archived = false) {
  const [squad] = await db
    .insert(squads)
    .values({
      name: `activity-access-${crypto.randomUUID()}`,
      purpose: 'test',
      ...(archived ? { archivedAt: new Date() } : {}),
    })
    .returning()
  squadIds.push(squad.id)
  return squad
}

describe('Activity access lifecycle', () => {
  test('denies an archived squad even when the caller still holds squads:read', async () => {
    const squad = await createSquad(true)
    const tokenId = crypto.randomUUID()
    systemTokenIds.push(tokenId)
    await db.insert(systemTokens).values({
      id: tokenId,
      name: 'archived-reader',
      tokenHash: crypto.randomUUID(),
      scopes: ['squads:read', 'workstreams:read'],
    })
    expect(
      await resolveSquadActivityAccess(
        {
          type: 'system',
          systemTokenId: tokenId,
          name: 'archived-reader',
          scopes: ['squads:read', 'workstreams:read'],
        },
        squad.id
      )
    ).toBeNull()
  })

  test('denies a disabled user even when a durable role still grants squad access', async () => {
    const squad = await createSquad()
    const [user] = await db
      .insert(users)
      .values({ email: `activity-disabled-${crypto.randomUUID()}@example.test`, disabledAt: new Date() })
      .returning()
    userIds.push(user.id)
    const [role] = await db
      .insert(roles)
      .values({
        slug: `activity-disabled-${crypto.randomUUID()}`,
        name: 'Activity disabled test',
        permissions: ['squads:read'],
      })
      .returning()
    roleIds.push(role.id)
    await db.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: user.id,
      roleId: role.id,
      scope: 'system',
    })
    expect(await resolveSquadActivityAccess({ type: 'user', userId: user.id }, squad.id)).toBeNull()
  })

  test('denies a deleted regular-agent identity instead of using fallback worker permissions', async () => {
    const squad = await createSquad()
    expect(
      await resolveSquadActivityAccess({ type: 'agent', agentId: crypto.randomUUID(), squadId: squad.id }, squad.id)
    ).toBeNull()
  })
})
