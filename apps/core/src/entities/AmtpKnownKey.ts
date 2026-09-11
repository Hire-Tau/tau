import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { amtpKnownKeys } from '../db/schema'

/**
 * Trust-on-first-use pin store for remote agents' published identity keys.
 * One row per (peerInstanceId, handle); the first key seen wins (no rotation).
 */
export class AmtpKnownKey {
  /** Return the pinned public PEM for (peer, handle), or null if not yet pinned. */
  static async getPin(peerInstanceId: string, handle: string): Promise<string | null> {
    const [row] = await db
      .select({ publicKey: amtpKnownKeys.publicKey })
      .from(amtpKnownKeys)
      .where(and(eq(amtpKnownKeys.peerInstanceId, peerInstanceId), eq(amtpKnownKeys.handle, handle)))
      .limit(1)
    return row?.publicKey ?? null
  }

  /**
   * Pin `publicKey` for (peer, handle) on first contact. Idempotent under races:
   * the conflicting insert is ignored and the EXISTING (first-seen) pin is returned.
   */
  static async recordPinIfNew(peerInstanceId: string, handle: string, publicKey: string): Promise<string> {
    await db.insert(amtpKnownKeys).values({ peerInstanceId, handle, publicKey }).onConflictDoNothing()
    const existing = await AmtpKnownKey.getPin(peerInstanceId, handle)
    return existing ?? publicKey
  }
}
