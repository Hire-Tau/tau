import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { db, inbox, squads, workStreams } from '../../db'
import { Squad } from '../../entities/Squad'
import { notifyWorkStreamBlocked, notifyWorkStreamReview } from '../squad/work-stream-notifications'
import {
  subscribeToWorkStream,
  unsubscribeFromWorkStream,
  isSubscribedToWorkStream,
  listWorkStreamSubscriberIds,
  getWorkStreamAttention,
} from './subscriptions'
import { cleanupTestRbac, createTestUser, type TestUser } from '../../test-utils'

const prefix = `wssub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let squad: Squad
let user: TestUser

beforeAll(async () => {
  user = await createTestUser({ prefix })
  squad = await Squad.create({ name: `${prefix} Squad`, purpose: 'work-stream subscription test' })
})

afterAll(async () => {
  await db.delete(inbox).where(inArray(inbox.recipientId, [user.id]))
  await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await cleanupTestRbac(prefix)
})

describe('work-stream subscriptions', () => {
  it('subscribe / isSubscribed / list / unsubscribe (idempotent)', async () => {
    const ws = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} ws1` })
    expect(await isSubscribedToWorkStream(ws.id, user.id)).toBe(false)

    await subscribeToWorkStream(ws.id, user.id)
    await subscribeToWorkStream(ws.id, user.id) // idempotent
    expect(await isSubscribedToWorkStream(ws.id, user.id)).toBe(true)
    expect(await listWorkStreamSubscriberIds(ws.id)).toEqual([user.id])

    await subscribeToWorkStream(ws.id, user.id, { decisions: 'show', progress: 'mute' })
    expect(await getWorkStreamAttention(ws.id, user.id)).toEqual({ decisions: 'show', progress: 'mute' })

    await unsubscribeFromWorkStream(ws.id, user.id)
    expect(await isSubscribedToWorkStream(ws.id, user.id)).toBe(false)
    expect(await getWorkStreamAttention(ws.id, user.id)).toBeNull()
  })

  it("delivers only high-signal lifecycle updates to a subscriber's personal inbox", async () => {
    const ws = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} ws2` })
    await subscribeToWorkStream(ws.id, user.id)

    await notifyWorkStreamBlocked(ws)
    await notifyWorkStreamReview(ws)

    const msgs = await db
      .select()
      .from(inbox)
      .where(and(eq(inbox.recipientType, 'user'), eq(inbox.recipientId, user.id)))
    expect(
      msgs.some(
        (m) =>
          (m.metadata as Record<string, unknown>)?.workStreamId === ws.id &&
          (m.metadata as Record<string, unknown>)?.event === 'blocked'
      )
    ).toBe(false)
    expect(
      msgs.some(
        (m) =>
          (m.metadata as Record<string, unknown>)?.workStreamId === ws.id &&
          (m.metadata as Record<string, unknown>)?.event === 'review'
      )
    ).toBe(true)
  })
})
