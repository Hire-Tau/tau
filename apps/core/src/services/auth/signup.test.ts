import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { roleAssignments } from '../../db/schema'
import { Role } from '../../entities/Role'
import { User } from '../../entities/User'
import { getAuthSettings, updateAuthSettings } from './email'
import { createSelfRegisteredUser } from './signup'

const ownedUsers: User[] = []
const ownedRoles: Role[] = []
async function role(appliesTo: 'user' | 'agent' = 'user') {
  const created = await Role.create({
    name: 'Sign-up test',
    slug: `signup-${crypto.randomUUID()}`,
    permissions: ['squads:read'],
    appliesTo,
  })
  ownedRoles.push(created)
  return created
}
async function register(domain = 'example.com') {
  const user = await createSelfRegisteredUser({ email: `signup-${crypto.randomUUID()}@${domain}` })
  if (user) ownedUsers.push(user)
  return user
}
afterEach(async () => {
  await updateAuthSettings({ requireInvite: true, allowedDomains: [], defaultSignupRoleId: null })
  for (const user of ownedUsers.splice(0)) await user.delete()
  for (const role of ownedRoles.splice(0)) if (await Role.findById(role.id)) await role.delete()
})

describe('self-registration default role', () => {
  test.each([false, true])(
    'assigns the role for requireInvite=%s when the domain is allowed',
    async (requireInvite) => {
      const selected = await role()
      await updateAuthSettings({ requireInvite, allowedDomains: ['Example.com'], defaultSignupRoleId: selected.id })
      const user = await register()
      expect(user).not.toBeNull()
      const assignments = await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user!.id))
      expect(assignments).toHaveLength(1)
      expect(assignments[0]).toMatchObject({ roleId: selected.id, subjectType: 'user', scope: 'system', squadId: null })
    }
  )
  test('No role creates an account without any grants', async () => {
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: null })
    const user = await register()
    expect(user).not.toBeNull()
    expect(await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user!.id))).toEqual([])
  })
  test('does not admit an unlisted domain, even with a default role', async () => {
    const selected = await role()
    await updateAuthSettings({ requireInvite: true, allowedDomains: ['example.com'], defaultSignupRoleId: selected.id })
    expect(await register('other.example')).toBeNull()
  })
  test('does not use a configured role to bypass invite-only admission', async () => {
    const selected = await role()
    await updateAuthSettings({ requireInvite: true, allowedDomains: [], defaultSignupRoleId: selected.id })
    expect(await register()).toBeNull()
  })
  test('changing the default does not change existing accounts', async () => {
    const selected = await role()
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: selected.id })
    const user = await register()
    await updateAuthSettings({ defaultSignupRoleId: null })
    expect((await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user!.id)))[0]?.roleId).toBe(
      selected.id
    )
  })
  test('deleting the selected role resets the policy to No role', async () => {
    const selected = await role()
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: selected.id })
    await selected.delete()
    expect((await getAuthSettings()).defaultSignupRoleId).toBeNull()
    const user = await register()
    expect(user).not.toBeNull()
    expect(await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user!.id))).toEqual([])
  })
  test('rejects an agent-only role even if an invalid policy was stored outside the API', async () => {
    const selected = await role('agent')
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: selected.id })
    expect(await register()).toBeNull()
  })
})
