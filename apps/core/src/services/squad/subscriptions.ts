import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { squadSubscriptions } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'

/**
 * Squad-level subscriptions ("watch the whole squad"). A squad watcher is treated as watching every
 * work stream in the squad (current and future) for review/completion notifications, and is the audience for
 * the squad's manager questions in the Action Center.
 */

export async function subscribeToSquad(squadId: string, userId: string): Promise<void> {
  await db.insert(squadSubscriptions).values({ squadId, userId }).onConflictDoNothing()
  eventEmitter.emit('liveActivity.interestChanged', { userId })
}

export async function unsubscribeFromSquad(squadId: string, userId: string): Promise<void> {
  await db
    .delete(squadSubscriptions)
    .where(and(eq(squadSubscriptions.squadId, squadId), eq(squadSubscriptions.userId, userId)))
  eventEmitter.emit('liveActivity.interestChanged', { userId })
}

export async function isSubscribedToSquad(squadId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: squadSubscriptions.userId })
    .from(squadSubscriptions)
    .where(and(eq(squadSubscriptions.squadId, squadId), eq(squadSubscriptions.userId, userId)))
    .limit(1)
  return Boolean(row)
}

export async function listSquadSubscriberIds(squadId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: squadSubscriptions.userId })
    .from(squadSubscriptions)
    .where(eq(squadSubscriptions.squadId, squadId))
  return rows.map((r) => r.userId)
}

/** Squad ids the user watches (used to scope the Action Center and notifications). */
export async function listUserWatchedSquadIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ squadId: squadSubscriptions.squadId })
    .from(squadSubscriptions)
    .where(eq(squadSubscriptions.userId, userId))
  return rows.map((r) => r.squadId)
}

export async function countSquadSubscribers(squadId: string): Promise<number> {
  return (await listSquadSubscriberIds(squadId)).length
}
