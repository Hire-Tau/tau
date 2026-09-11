import { randomUUID } from 'crypto'
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import { integrationEventPollingCursors } from '../../db/schema'
import type { EventPollingCursorStore } from './event-polling-runner'

/** PostgreSQL lease store preventing concurrent workers from polling one resource. */
export class DbEventPollingCursorStore implements EventPollingCursorStore {
  async claim(providerKey: string, resourceKey: string, _now: Date, leaseMs: number) {
    await db.insert(integrationEventPollingCursors).values({ providerKey, resourceKey }).onConflictDoNothing()
    const leaseToken = randomUUID()
    const [claimed] = await db
      .update(integrationEventPollingCursors)
      .set({
        leaseToken,
        leaseUntil: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationEventPollingCursors.providerKey, providerKey),
          eq(integrationEventPollingCursors.resourceKey, resourceKey),
          lte(integrationEventPollingCursors.nextPollAt, sql`clock_timestamp()`),
          or(
            isNull(integrationEventPollingCursors.leaseUntil),
            lte(integrationEventPollingCursors.leaseUntil, sql`clock_timestamp()`)
          )
        )
      )
      .returning({
        cursor: integrationEventPollingCursors.cursor,
        leaseUntil: integrationEventPollingCursors.leaseUntil,
      })
    return claimed && claimed.leaseUntil ? { cursor: claimed.cursor, leaseToken, leaseUntil: claimed.leaseUntil } : null
  }

  async save(
    providerKey: string,
    resourceKey: string,
    leaseToken: string,
    cursor: Record<string, unknown>,
    nextPollAt: Date
  ): Promise<void> {
    const [saved] = await db
      .update(integrationEventPollingCursors)
      .set({ cursor, nextPollAt, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(
        and(
          eq(integrationEventPollingCursors.providerKey, providerKey),
          eq(integrationEventPollingCursors.resourceKey, resourceKey),
          eq(integrationEventPollingCursors.leaseToken, leaseToken)
        )
      )
      .returning({ providerKey: integrationEventPollingCursors.providerKey })
    if (!saved) throw new Error(`Event polling cursor lease lost for ${providerKey}:${resourceKey}`)
  }

  async renew(providerKey: string, resourceKey: string, leaseToken: string, leaseMs: number): Promise<Date | null> {
    const [renewed] = await db
      .update(integrationEventPollingCursors)
      .set({
        leaseUntil: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationEventPollingCursors.providerKey, providerKey),
          eq(integrationEventPollingCursors.resourceKey, resourceKey),
          eq(integrationEventPollingCursors.leaseToken, leaseToken)
        )
      )
      .returning({ leaseUntil: integrationEventPollingCursors.leaseUntil })
    return renewed?.leaseUntil ?? null
  }

  async fail(providerKey: string, resourceKey: string, leaseToken: string, retryAt: Date): Promise<boolean> {
    const [failed] = await db
      .update(integrationEventPollingCursors)
      .set({
        nextPollAt: retryAt,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationEventPollingCursors.providerKey, providerKey),
          eq(integrationEventPollingCursors.resourceKey, resourceKey),
          eq(integrationEventPollingCursors.leaseToken, leaseToken)
        )
      )
      .returning({ providerKey: integrationEventPollingCursors.providerKey })
    return Boolean(failed)
  }

  async release(providerKey: string, resourceKey: string, leaseToken: string): Promise<void> {
    await db
      .update(integrationEventPollingCursors)
      .set({ leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(
        and(
          eq(integrationEventPollingCursors.providerKey, providerKey),
          eq(integrationEventPollingCursors.resourceKey, resourceKey),
          eq(integrationEventPollingCursors.leaseToken, leaseToken)
        )
      )
  }
}
