import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { roles, roleAssignments, userCredentials, users } from '../../db/schema'

/** True if at least one enabled user holds the system-scoped `admin` role. */
export async function hasAdminUsers(): Promise<boolean> {
  const result = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.scope, 'system'),
        eq(roles.slug, 'admin'),
        isNull(users.disabledAt)
      )
    )
    .limit(1)

  return result.length > 0
}

/**
 * True if at least one enabled admin user has a registered passkey credential.
 *
 * This is the source of truth for the password-vs-passkey decision: the
 * bootstrap `TAU_PASSWORD` may authenticate, and the UI should offer password
 * login, precisely while this returns `false`.
 *
 * It is strictly wider than `hasAdminUsers()` only in the "admin users exist
 * but none holds a passkey" state. That state is the deliberate
 * cross-subdomain restore case: a backup restored onto a NEW origin keeps the
 * user/role rows but every WebAuthn credential is dead (origin-bound), so the
 * platform strips the credential rows. Without this predicate such an instance
 * would be a total lockout (no working passkey, and the password rejected the
 * moment any admin row exists). Re-enabling the env-held password there is a
 * recovery improvement — the state is otherwise reachable only if every admin
 * deletes every passkey, in which case the instance is already unrecoverable
 * today. The moment an admin registers a passkey this flips to `true` and
 * password auth turns off again.
 */
export async function adminHasPasskey(): Promise<boolean> {
  const result = await db
    .select({ id: userCredentials.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(users, sql`${users.id}::text = ${roleAssignments.subjectId}`)
    .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
    .where(
      and(
        eq(roleAssignments.subjectType, 'user'),
        eq(roleAssignments.scope, 'system'),
        eq(roles.slug, 'admin'),
        isNull(users.disabledAt)
      )
    )
    .limit(1)

  return result.length > 0
}
