import { eq } from 'drizzle-orm'
import { db } from '../db'
import { userNotificationPreferences } from '../db/schema'

export interface NotificationPreferences {
  showPreviews: boolean
  pushEnabled: boolean
  /** Event types the user has muted (no push), e.g. ['inbox.messageReceived']. */
  mutedEvents: string[]
}

const DEFAULTS: NotificationPreferences = { showPreviews: false, pushEnabled: true, mutedEvents: [] }

/**
 * Per-user notification preferences. Notification *delivery* (push) is per-user; the shared
 * notification rules (which events route where, external squad channels) remain global.
 */
export class UserNotificationPreferences {
  /** A user's preferences, defaulting to push-on / nothing-muted when no row exists. */
  static async get(userId: string): Promise<NotificationPreferences> {
    const [row] = await db
      .select()
      .from(userNotificationPreferences)
      .where(eq(userNotificationPreferences.userId, userId))
    if (!row) return { ...DEFAULTS }
    return {
      showPreviews: row.showPreviews,
      pushEnabled: row.pushEnabled,
      mutedEvents: (row.mutedEvents as string[]) ?? [],
    }
  }

  /** Whether a push for the given event type should be delivered to this user. */
  static async shouldPush(userId: string, eventType: string): Promise<boolean> {
    const prefs = await UserNotificationPreferences.get(userId)
    return prefs.pushEnabled && !prefs.mutedEvents.includes(eventType)
  }

  static async upsert(userId: string, input: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
    const current = await UserNotificationPreferences.get(userId)
    const next: NotificationPreferences = {
      showPreviews: input.showPreviews ?? current.showPreviews,
      pushEnabled: input.pushEnabled ?? current.pushEnabled,
      mutedEvents: input.mutedEvents ?? current.mutedEvents,
    }
    await db
      .insert(userNotificationPreferences)
      .values({
        userId,
        showPreviews: next.showPreviews,
        pushEnabled: next.pushEnabled,
        mutedEvents: next.mutedEvents,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userNotificationPreferences.userId,
        set: {
          showPreviews: next.showPreviews,
          pushEnabled: next.pushEnabled,
          mutedEvents: next.mutedEvents,
          updatedAt: new Date(),
        },
      })
    return next
  }
}
