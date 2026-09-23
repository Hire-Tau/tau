import { afterEach, describe, expect, test } from 'bun:test'
import { cleanupTestRbac, createTestAdmin, createTestCredential, createTestUser } from '../../test-utils/rbac'
import { db } from '../../db'
import { userCredentials, users } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { adminHasPasskey, hasAdminUsers, pendingAdminSetup } from './admin-users'

const PREFIX = 'admin-users-test'

afterEach(() => cleanupTestRbac(PREFIX))

describe('adminHasPasskey', () => {
  test('false when no admin users exist', async () => {
    expect(await adminHasPasskey()).toBe(false)
  })

  test('false when a canonical admin exists but holds no passkey (restored state)', async () => {
    await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })
    // hasAdminUsers is true here — the two predicates deliberately diverge.
    expect(await hasAdminUsers()).toBe(true)
    expect(await adminHasPasskey()).toBe(false)
  })

  test('true once a canonical admin registers a passkey', async () => {
    const admin = await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })
    await createTestCredential({ userId: admin.id })
    expect(await adminHasPasskey()).toBe(true)
  })

  test('ignores passkeys held by non-admin users', async () => {
    // Admin without a credential…
    await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })
    // …and a separate ordinary user WHO has one. The admin gate must not count it.
    const plainUser = await createTestUser({ prefix: PREFIX })
    await createTestCredential({ userId: plainUser.id })
    expect(await adminHasPasskey()).toBe(false)
  })

  test('flips back to false if the admin removes their only passkey', async () => {
    const admin = await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })
    const credId = await createTestCredential({ userId: admin.id })
    expect(await adminHasPasskey()).toBe(true)

    await db.delete(userCredentials).where(eq(userCredentials.id, credId))
    expect(await adminHasPasskey()).toBe(false)
  })
})

describe('pendingAdminSetup', () => {
  const mine = async () =>
    (await pendingAdminSetup()).accounts.filter((account) => account.email.startsWith(`${PREFIX}-`))

  test('with no admin yet: every enabled account without a passkey, oldest first', async () => {
    const first = await createTestUser({ prefix: PREFIX })
    const second = await createTestUser({ prefix: PREFIX })
    const joined = await createTestUser({ prefix: PREFIX })
    await createTestCredential({ userId: joined.id })
    const disabled = await createTestUser({ prefix: PREFIX })
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.id))

    expect((await pendingAdminSetup()).adminExists).toBe(false)
    expect((await mine()).map((account) => account.id)).toEqual([first.id, second.id])
  })

  test('once an admin row exists: only the passkey-less admins', async () => {
    const admin = await createTestAdmin({ prefix: PREFIX, canonicalAdmin: true })
    await createTestUser({ prefix: PREFIX })

    expect((await pendingAdminSetup()).adminExists).toBe(true)
    expect(await mine()).toEqual([{ id: admin.id, email: admin.email, displayName: admin.displayName }])
  })
})
