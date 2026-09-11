import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { workStreamSubscriptions } from '../../db/schema'
import { eventEmitter } from '../../lib/infra/event-emitter'

/**
 * Work-stream subscriptions ("watchers"). Any user can subscribe to a work stream to receive review and
 * completion updates in their personal inbox (and push, subject to their notification preferences) —
 * like watching a GitHub PR/issue. The requesting user is auto-subscribed on creation.
 */

export async function subscribeToWorkStream(workStreamId: string, userId: string): Promise<void> {
  await db.insert(workStreamSubscriptions).values({ workStreamId, userId }).onConflictDoNothing()
  eventEmitter.emit('liveActivity.interestChanged', { userId })
}

export async function unsubscribeFromWorkStream(workStreamId: string, userId: string): Promise<void> {
  await db
    .delete(workStreamSubscriptions)
    .where(and(eq(workStreamSubscriptions.workStreamId, workStreamId), eq(workStreamSubscriptions.userId, userId)))
  eventEmitter.emit('liveActivity.interestChanged', { userId })
}

export async function isSubscribedToWorkStream(workStreamId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: workStreamSubscriptions.userId })
    .from(workStreamSubscriptions)
    .where(and(eq(workStreamSubscriptions.workStreamId, workStreamId), eq(workStreamSubscriptions.userId, userId)))
    .limit(1)
  return Boolean(row)
}

export async function listWorkStreamSubscriberIds(workStreamId: string, executor: typeof db = db): Promise<string[]> {
  const rows = await executor
    .select({ userId: workStreamSubscriptions.userId })
    .from(workStreamSubscriptions)
    .where(eq(workStreamSubscriptions.workStreamId, workStreamId))
  return rows.map((r) => r.userId)
}

/** Work stream ids the user explicitly watches (does not include squad-level watches). */
export async function listUserWatchedWorkStreamIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ workStreamId: workStreamSubscriptions.workStreamId })
    .from(workStreamSubscriptions)
    .where(eq(workStreamSubscriptions.userId, userId))
  return rows.map((r) => r.workStreamId)
}

export async function countWorkStreamSubscribers(workStreamId: string): Promise<number> {
  return (await listWorkStreamSubscriberIds(workStreamId)).length
}
