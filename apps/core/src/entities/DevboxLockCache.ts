import { eq } from 'drizzle-orm'
import { db } from '../db'
import { devboxLockCache } from '../db/schema'

/**
 * Cache of a generated `devbox.lock` per comfort-set content hash. See
 * devbox-seed.ts's module doc for why this exists and what it does NOT do
 * (no invalidation beyond the hash changing).
 */
export class DevboxLockCache {
  /** Return the cached lock content for `seedHash`, or null if not cached. */
  static async get(seedHash: string): Promise<string | null> {
    const [row] = await db
      .select({ lockContent: devboxLockCache.lockContent })
      .from(devboxLockCache)
      .where(eq(devboxLockCache.seedHash, seedHash))
      .limit(1)
    return row?.lockContent ?? null
  }

  /**
   * Store `lockContent` under `seedHash` if no entry exists yet. Idempotent
   * under races: a concurrent writer that lands first wins and this call is a
   * no-op (the content is the content-addressed devbox resolution for the
   * same devbox.json, so which writer wins does not matter).
   */
  static async storeIfAbsent(seedHash: string, lockContent: string): Promise<void> {
    await db.insert(devboxLockCache).values({ seedHash, lockContent }).onConflictDoNothing()
  }
}
