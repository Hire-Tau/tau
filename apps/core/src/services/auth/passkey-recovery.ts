import { and, eq, ne } from 'drizzle-orm'
import { db } from '../../db'
import { sessions, userCredentials } from '../../db/schema'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('passkey-recovery')

/**
 * Finish a passkey recovery: the freshly registered credential REPLACES every
 * other one on the account, and all existing sessions are revoked with them.
 *
 * Recovery means "I no longer control the authenticator I had". Leaving the old
 * credential enrolled would leave whoever does control it able to sign in, and
 * leaving its sessions alive would leave them signed in already — so recovery is
 * a full credential reset, not an addition. It is deliberately run only AFTER the
 * new credential is stored, so a failure mid-flight can never strand the account
 * with no way in at all.
 */
export async function replaceCredentialsAfterRecovery(
  userId: string,
  keepCredentialId: string
): Promise<{ removedCredentials: number; removedSessions: number }> {
  const removedCredentials = await db
    .delete(userCredentials)
    .where(and(eq(userCredentials.userId, userId), ne(userCredentials.credentialId, keepCredentialId)))
    .returning({ id: userCredentials.id })

  const removedSessions = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id })

  log.info(
    `Passkey recovery for user ${userId}: removed ${removedCredentials.length} old credential(s), ${removedSessions.length} session(s)`
  )
  return { removedCredentials: removedCredentials.length, removedSessions: removedSessions.length }
}
