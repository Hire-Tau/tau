import { randomUUID } from 'crypto'
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db'
import { integrationEventPollingDispatches } from '../../db/schema'
import type { EventPollingDispatchStore } from './event-polling-runner'

/** Durable logical-event leases shared by every polling resource and replica. */
export class DbEventPollingDispatchStore implements EventPollingDispatchStore {
  async claim(providerKey: string, eventKey: string, leaseMs: number) {
    await db
      .insert(integrationEventPollingDispatches)
      .values({ providerKey, eventKey, activityId: randomUUID() })
      .onConflictDoNothing()
    const leaseToken = randomUUID()
    const [claimed] = await db
      .update(integrationEventPollingDispatches)
      .set({
        leaseToken,
        leaseUntil: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationEventPollingDispatches.providerKey, providerKey),
          eq(integrationEventPollingDispatches.eventKey, eventKey),
          isNull(integrationEventPollingDispatches.completedAt),
          or(
            isNull(integrationEventPollingDispatches.leaseUntil),
            lte(integrationEventPollingDispatches.leaseUntil, sql`clock_timestamp()`)
          )
        )
      )
      .returning({ eventKey: integrationEventPollingDispatches.eventKey })
    if (claimed) return { status: 'claimed' as const, leaseToken }
    const [existing] = await db
      .select({
        completedAt: integrationEventPollingDispatches.completedAt,
        activityId: integrationEventPollingDispatches.activityId,
        eventFact: integrationEventPollingDispatches.eventFact,
        eventOccurredAt: integrationEventPollingDispatches.eventOccurredAt,
      })
      .from(integrationEventPollingDispatches)
      .where(
        and(
          eq(integrationEventPollingDispatches.providerKey, providerKey),
          eq(integrationEventPollingDispatches.eventKey, eventKey)
        )
      )
      .limit(1)
    return existing?.completedAt
      ? ({
          status: 'completed',
          ...(existing.activityId && existing.eventFact && existing.eventOccurredAt
            ? {
                dispatch: {
                  activityId: existing.activityId,
                  eventFact: existing.eventFact,
                  eventOccurredAt: existing.eventOccurredAt,
                },
              }
            : {}),
        } as const)
      : ({ status: 'busy' } as const)
  }

  async complete(
    providerKey: string,
    eventKey: string,
    leaseToken: string,
    fact?: { eventFact: unknown; eventOccurredAt: Date; activitySquadId: string }
  ) {
    const activityId = randomUUID()
    const [completed] = await db
      .update(integrationEventPollingDispatches)
      .set({
        completedAt: sql`clock_timestamp()`,
        activityId: fact
          ? sql`COALESCE(${integrationEventPollingDispatches.activityId}, ${activityId}::uuid)`
          : undefined,
        eventFact: fact?.eventFact as any,
        eventOccurredAt: fact?.eventOccurredAt,
        activitySquadIds: fact
          ? sql`CASE WHEN ${fact.activitySquadId}::uuid=ANY(${integrationEventPollingDispatches.activitySquadIds})
              THEN ${integrationEventPollingDispatches.activitySquadIds}
              ELSE array_append(${integrationEventPollingDispatches.activitySquadIds},${fact.activitySquadId}::uuid) END`
          : undefined,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationEventPollingDispatches.providerKey, providerKey),
          eq(integrationEventPollingDispatches.eventKey, eventKey),
          eq(integrationEventPollingDispatches.leaseToken, leaseToken),
          isNull(integrationEventPollingDispatches.completedAt)
        )
      )
      .returning({
        eventKey: integrationEventPollingDispatches.eventKey,
        activityId: integrationEventPollingDispatches.activityId,
        eventFact: integrationEventPollingDispatches.eventFact,
        eventOccurredAt: integrationEventPollingDispatches.eventOccurredAt,
      })
    if (!completed) throw new Error(`Event polling dispatch lease lost for ${providerKey}:${eventKey}`)
    return completed.activityId && completed.eventFact && completed.eventOccurredAt
      ? { activityId: completed.activityId, eventFact: completed.eventFact, eventOccurredAt: completed.eventOccurredAt }
      : undefined
  }

  async authorizeActivitySquad(providerKey: string, eventKey: string, squadId: string): Promise<boolean> {
    const authorized = await db.execute<any>(sql`UPDATE integration_event_polling_dispatches
      SET activity_squad_ids=CASE WHEN ${squadId}::uuid=ANY(activity_squad_ids) THEN activity_squad_ids
        ELSE array_append(activity_squad_ids,${squadId}::uuid) END
      WHERE provider_key=${providerKey} AND event_key=${eventKey} AND completed_at IS NOT NULL AND event_fact IS NOT NULL
        AND cardinality(activity_squad_ids)>0
      RETURNING event_key`)
    return authorized.length > 0
  }

  async release(providerKey: string, eventKey: string, leaseToken: string): Promise<void> {
    await db
      .update(integrationEventPollingDispatches)
      .set({ leaseToken: null, leaseUntil: null, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(integrationEventPollingDispatches.providerKey, providerKey),
          eq(integrationEventPollingDispatches.eventKey, eventKey),
          eq(integrationEventPollingDispatches.leaseToken, leaseToken),
          isNull(integrationEventPollingDispatches.completedAt)
        )
      )
  }
}
