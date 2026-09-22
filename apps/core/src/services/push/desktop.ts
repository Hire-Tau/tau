import { createHash } from 'node:crypto'
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm'
import type { PushCategory } from '@tau/shared'
import type { NotificationEvent } from '../../channels/provider'
import { db, desktopNotifications } from '../../db'
import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'

/** OS alerts are a bounded view of durable work/inbox state; reading never acknowledges the underlying work. */
export async function enqueueDesktopNotifications(
  userIds: string[],
  event: NotificationEvent,
  eventType: string,
  category: PushCategory
): Promise<void> {
  if (process.env.TAU_DESKTOP_MANAGED !== '1' || !userIds.length) return
  const eventKey = createHash('sha256')
    .update(
      JSON.stringify([
        eventType,
        event.messageId ?? event.questionId ?? event.timestamp.toISOString(),
        event.title,
        event.body,
      ])
    )
    .digest('hex')
  await db
    .insert(desktopNotifications)
    .values(
      [...new Set(userIds)].map((userId) => ({
        userId,
        eventKey,
        eventType,
        category,
        title: event.title.slice(0, 200),
        body: event.body.slice(0, 500),
        url: event.url ?? '/inbox',
      }))
    )
    .onConflictDoNothing()
  await db.delete(desktopNotifications).where(lt(desktopNotifications.createdAt, sql`now() - interval '7 days'`))
}

export async function listDesktopNotifications(userId: string) {
  const preferences = await UserNotificationPreferences.get(userId)
  if (!preferences.pushEnabled) return []
  const rows = await db
    .select()
    .from(desktopNotifications)
    .where(
      and(eq(desktopNotifications.userId, userId), gt(desktopNotifications.createdAt, sql`now() - interval '7 days'`))
    )
    .orderBy(desc(desktopNotifications.createdAt), desc(desktopNotifications.id))
    .limit(100)
  return rows
    .filter(
      (row) => !preferences.mutedEvents.includes(row.eventType) && !preferences.mutedEvents.includes(row.category)
    )
    .map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      url: row.url,
      title: preferences.showPreviews ? row.title : 'Tau update',
      body: preferences.showPreviews ? row.body : 'Open Tau to see your update.',
    }))
}
