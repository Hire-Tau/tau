import { and, eq, lt } from 'drizzle-orm'
import { db } from '../db'
import { amtpReceived } from '../db/schema'

export class AmtpReceived {
  /**
   * Record that an envelope was received from a peer. Returns true iff this is
   * the first sighting (a row was inserted); false if (peerInstanceId, envelopeId)
   * was already recorded. Used by the receiver route for replay/dedup.
   */
  static async recordIfNew(peerInstanceId: string, envelopeId: string): Promise<boolean> {
    const rows = await db.insert(amtpReceived).values({ peerInstanceId, envelopeId }).onConflictDoNothing().returning()
    return rows.length > 0
  }

  /**
   * Remove the dedup record for (peerInstanceId, envelopeId), releasing the slot so
   * the sender's retry will be treated as a first sighting again. Call this when delivery
   * fails after the slot was claimed, to avoid silent message loss on retry.
   */
  static async unrecord(peerInstanceId: string, envelopeId: string): Promise<void> {
    await db
      .delete(amtpReceived)
      .where(and(eq(amtpReceived.peerInstanceId, peerInstanceId), eq(amtpReceived.envelopeId, envelopeId)))
  }

  /**
   * Delete dedup rows older than `olderThanMs` milliseconds (default: 10 minutes).
   * Any envelope outside the ±5-minute freshness window can no longer be replayed, so
   * these rows are safe to prune. Call periodically to bound table growth.
   */
  static async pruneOld(olderThanMs: number = 10 * 60 * 1000, now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - olderThanMs)
    await db.delete(amtpReceived).where(lt(amtpReceived.receivedAt, cutoff))
  }
}
