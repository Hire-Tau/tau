import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULT_ATTENTION, WATCH_ATTENTION } from '@tau/shared'
import { eq, inArray } from 'drizzle-orm'
import { db, squads, workStreams } from '../../db'
import { Squad } from '../../entities/Squad'
import { subscribeToSquad, getSquadAttention, listUserSquadAttention } from '../squad/subscriptions'
import { subscribeToWorkStream, getWorkStreamAttention } from '../work-streams/subscriptions'
import { cleanupTestRbac, createTestUser, type TestUser } from '../../test-utils'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import {
  EMPTY_USER_ATTENTION,
  listSquadScopeNotifyUserIds,
  listWorkStreamNotifyUserIds,
  loadUserAttention,
} from './resolver'

const prefix = `attention-resolver-${crypto.randomUUID().slice(0, 8)}`

let squad: Squad
let streamA: { id: string }
let streamB: { id: string }
let watcher: TestUser
let muter: TestUser
let stranger: TestUser

beforeAll(async () => {
  squad = await Squad.create({ name: `${prefix} squad`, purpose: 'attention resolver test' })
  streamA = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} stream A` })
  streamB = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} stream B` })
  watcher = await createTestUser({ prefix })
  muter = await createTestUser({ prefix })
  stranger = await createTestUser({ prefix })
})

afterAll(async () => {
  await db.delete(workStreams).where(inArray(workStreams.id, [streamA.id, streamB.id]))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await cleanupTestRbac(prefix)
})

describe('subscription attention storage', () => {
  test('a plain subscribe stores watch levels and a second plain subscribe never overwrites them', async () => {
    await subscribeToSquad(squad.id, watcher.id)
    expect(await getSquadAttention(squad.id, watcher.id)).toEqual(WATCH_ATTENTION)

    await subscribeToSquad(squad.id, watcher.id, { decisions: 'notify', progress: 'mute' })
    await subscribeToSquad(squad.id, watcher.id)
    expect(await getSquadAttention(squad.id, watcher.id)).toEqual({ decisions: 'notify', progress: 'mute' })

    expect(await listUserSquadAttention(watcher.id)).toEqual(
      new Map([[squad.id, { decisions: 'notify', progress: 'mute' }]])
    )
  })

  test('an explicit subscribe upserts levels on an existing row', async () => {
    await subscribeToWorkStream(streamA.id, watcher.id, { decisions: 'mute', progress: 'show' })
    expect(await getWorkStreamAttention(streamA.id, watcher.id)).toEqual({ decisions: 'mute', progress: 'show' })
    await subscribeToWorkStream(streamA.id, watcher.id, { decisions: 'show', progress: 'notify' })
    expect(await getWorkStreamAttention(streamA.id, watcher.id)).toEqual({ decisions: 'show', progress: 'notify' })
  })

  test('no row reads as null, not as a default', async () => {
    expect(await getSquadAttention(squad.id, stranger.id)).toBeNull()
    expect(await getWorkStreamAttention(streamB.id, stranger.id)).toBeNull()
  })
})

describe('effective attention precedence', () => {
  test('stream row beats squad row beats the default', async () => {
    const attention = await loadUserAttention(watcher.id)
    // Squad row: notify/mute. Stream A row: show/notify. Stream B: inherits the squad row.
    expect(attention.forSquad(squad.id)).toEqual({ decisions: 'notify', progress: 'mute' })
    expect(attention.forWorkStream(streamA.id, squad.id)).toEqual({ decisions: 'show', progress: 'notify' })
    expect(attention.forWorkStream(streamB.id, squad.id)).toEqual({ decisions: 'notify', progress: 'mute' })
    expect(attention.forSquad(null)).toEqual(DEFAULT_ATTENTION)

    const none = await loadUserAttention(stranger.id)
    expect(none.forSquad(squad.id)).toEqual(DEFAULT_ATTENTION)
    expect(none.forWorkStream(streamA.id, squad.id)).toEqual(DEFAULT_ATTENTION)
    expect(EMPTY_USER_ATTENTION.forWorkStream(streamA.id, squad.id)).toEqual(DEFAULT_ATTENTION)
  })
})

describe('notify recipient queries', () => {
  test('only rows can notify, and the stream row decides for its own stream', async () => {
    await subscribeToSquad(squad.id, muter.id, WATCH_ATTENTION)
    await subscribeToWorkStream(streamA.id, muter.id, { decisions: 'mute', progress: 'mute' })

    // Stream A: watcher progress notify (stream row), muter muted by its stream row.
    expect(await listWorkStreamNotifyUserIds(streamA.id, squad.id, 'progress')).toEqual([watcher.id])
    expect(await listWorkStreamNotifyUserIds(streamA.id, squad.id, 'decisions')).toEqual([])

    // Stream B inherits: watcher notifies on decisions only, muter notifies on both.
    expect((await listWorkStreamNotifyUserIds(streamB.id, squad.id, 'decisions')).sort()).toEqual(
      [watcher.id, muter.id].sort()
    )
    expect(await listWorkStreamNotifyUserIds(streamB.id, squad.id, 'progress')).toEqual([muter.id])

    // A user with no row anywhere is never a notify recipient — the default never notifies.
    expect(await listWorkStreamNotifyUserIds(streamB.id, squad.id, 'progress')).not.toContain(stranger.id)
  })

  test('squad-scope notify unions the squad itself with the given origin streams', async () => {
    expect((await listSquadScopeNotifyUserIds(squad.id, [], 'decisions')).sort()).toEqual([watcher.id, muter.id].sort())
    // Stream A mutes the muter's decisions, but the squad row still notifies for squad-level items.
    expect((await listSquadScopeNotifyUserIds(squad.id, [streamA.id], 'decisions')).sort()).toEqual(
      [watcher.id, muter.id].sort()
    )
    expect(await listSquadScopeNotifyUserIds(null, [], 'decisions')).toEqual([])
  })
})
