import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { liveActivityTokens, users } from '../../db/schema'
import {
  deleteLiveActivityToken,
  deleteLiveActivityTokenForUser,
  listLiveActivityTokens,
  registerLiveActivityToken,
} from './live-activity-tokens'

describe('live activity token registry', () => {
  let userId: string
  let otherUserId: string

  beforeEach(async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `la-${crypto.randomUUID()}@example.test`, displayName: 'LA user' })
      .returning({ id: users.id })
    const [other] = await db
      .insert(users)
      .values({ email: `la-${crypto.randomUUID()}@example.test`, displayName: 'Other user' })
      .returning({ id: users.id })
    userId = user!.id
    otherUserId = other!.id
  })

  afterEach(async () => {
    for (const id of [userId, otherUserId]) await db.delete(users).where(eq(users.id, id))
  })

  // The app re-registers on every activity restart, so a non-idempotent insert would grow a row
  // per activity and fan out duplicate pushes to the same device.
  test('upserts by token rather than accumulating a row per registration', async () => {
    await registerLiveActivityToken({ userId, apnsToken: 'tok-a', kind: 'update', activityId: 'act-1' })
    const second = await registerLiveActivityToken({
      userId,
      apnsToken: 'tok-a',
      kind: 'update',
      activityId: 'act-2',
    })
    const rows = await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.apnsToken, 'tok-a'))
    expect(rows).toHaveLength(1)
    // The same token can legitimately move to a new activity — the row must follow it.
    expect(second!.activityId).toBe('act-2')
    expect(rows[0]!.lastUsedAt).not.toBeNull()
  })

  test("a 'start' token never carries an activityId, even if one is passed", async () => {
    const row = await registerLiveActivityToken({
      userId,
      apnsToken: 'tok-start',
      kind: 'start',
      activityId: 'should-be-ignored',
    })
    expect(row!.activityId).toBeNull()
  })

  test('re-registering an update token as a start token clears the stale activity id', async () => {
    await registerLiveActivityToken({ userId, apnsToken: 'tok-b', kind: 'update', activityId: 'act-1' })
    const row = await registerLiveActivityToken({ userId, apnsToken: 'tok-b', kind: 'start' })
    expect(row!.kind).toBe('start')
    expect(row!.activityId).toBeNull()
  })

  test('filters by kind for fan-out', async () => {
    await registerLiveActivityToken({ userId, apnsToken: 'tok-u', kind: 'update', activityId: 'act-1' })
    await registerLiveActivityToken({ userId, apnsToken: 'tok-s', kind: 'start' })
    expect((await listLiveActivityTokens([userId], 'update')).map((row) => row.apnsToken)).toEqual(['tok-u'])
    expect((await listLiveActivityTokens([userId], 'start')).map((row) => row.apnsToken)).toEqual(['tok-s'])
    expect((await listLiveActivityTokens([userId])).map((row) => row.apnsToken).sort()).toEqual(['tok-s', 'tok-u'])
  })

  test('an empty user list returns nothing rather than every row in the table', async () => {
    await registerLiveActivityToken({ userId, apnsToken: 'tok-c', kind: 'start' })
    expect(await listLiveActivityTokens([])).toEqual([])
  })

  test('delete reports whether it actually removed a row (410 races the app unregistering)', async () => {
    await registerLiveActivityToken({ userId, apnsToken: 'tok-d', kind: 'start' })
    expect(await deleteLiveActivityToken('tok-d')).toBe(true)
    expect(await deleteLiveActivityToken('tok-d')).toBe(false)
  })

  test('a user cannot delete another user’s token', async () => {
    await registerLiveActivityToken({ userId, apnsToken: 'tok-e', kind: 'start' })
    expect(await deleteLiveActivityTokenForUser('tok-e', otherUserId)).toBe(false)
    expect(await deleteLiveActivityTokenForUser('tok-e', userId)).toBe(true)
  })

  // NOT tested here: the ON DELETE CASCADE to users. The test database is built by
  // `drizzle-kit push`, which creates NO foreign keys at all in this setup (verified: neither
  // apns_devices nor device_tokens has one either), so a cascade assertion would fail on the
  // harness while passing in production — worse than no test. The cascade is declared in
  // db/schema.ts and emitted in drizzle/0139_*.sql, which is where it is actually guaranteed.
})
