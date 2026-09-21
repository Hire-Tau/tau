import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { db, inbox, squads, workStreams } from '../../db'
import { Squad } from '../../entities/Squad'
import { notifyWorkStreamBlocked, notifyWorkStreamReview } from './work-stream-notifications'
import {
  subscribeToSquad,
  unsubscribeFromSquad,
  isSubscribedToSquad,
  listSquadSubscriberIds,
  listUserSquadAttention,
} from './subscriptions'
import { assignRole, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../../test-utils'

const prefix = `squadsub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let squad: Squad
let user: TestUser

beforeAll(async () => {
  user = await createTestUser({ prefix })
  squad = await Squad.create({ name: `${prefix} Squad`, purpose: 'squad subscription test' })
  // Notices are permission-gated before attention: without a reader role the subscriber hears nothing.
  const role = await createTestRole({ prefix, permissions: ['workstreams:read'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })
})

afterAll(async () => {
  await db.delete(inbox).where(inArray(inbox.recipientId, [user.id]))
  await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await cleanupTestRbac(prefix)
})

describe('squad subscriptions', () => {
  it('subscribe / isSubscribed / list / attention-by-user / unsubscribe', async () => {
    expect(await isSubscribedToSquad(squad.id, user.id)).toBe(false)
    await subscribeToSquad(squad.id, user.id)
    await subscribeToSquad(squad.id, user.id) // idempotent
    expect(await isSubscribedToSquad(squad.id, user.id)).toBe(true)
    expect(await listSquadSubscriberIds(squad.id)).toEqual([user.id])
    expect((await listUserSquadAttention(user.id)).get(squad.id)).toEqual({ decisions: 'notify', progress: 'notify' })
    await unsubscribeFromSquad(squad.id, user.id)
    expect(await isSubscribedToSquad(squad.id, user.id)).toBe(false)
  })

  it('a squad watcher receives decision and completion updates for streams they never explicitly watched', async () => {
    await subscribeToSquad(squad.id, user.id)
    // A brand-new stream the user did NOT per-stream-subscribe to.
    const ws = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} unwatched-stream` })

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
    ).toBe(true)
    expect(
      msgs.some(
        (m) =>
          (m.metadata as Record<string, unknown>)?.workStreamId === ws.id &&
          (m.metadata as Record<string, unknown>)?.event === 'review'
      )
    ).toBe(true)
  })
})
