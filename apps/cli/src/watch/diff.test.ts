import { describe, expect, it } from 'bun:test'
import { IDLE_MS, diffSnapshots, type IdleState } from './diff'
import type { Snapshot, StreamEntry } from './snapshot'

const empty = (): Snapshot => ({ v: 1, streams: {}, actions: {}, inbox: {} })
const entry = (over: Partial<StreamEntry> = {}): StreamEntry => ({
  status: 'active',
  derived: 'in_progress',
  active: 1,
  waits: {},
  squadId: 'sq',
  title: 'Ship it',
  ...over,
})
const withStream = (id: string, s: StreamEntry, base = empty()): Snapshot => ({
  ...base,
  streams: { ...base.streams, [id]: s },
})
const kinds = (events: ReturnType<typeof diffSnapshots>) => events.map((e) => e.kind)

describe('diffSnapshots — work streams', () => {
  it('reports a newly seen active or queued stream', () => {
    const events = diffSnapshots(empty(), withStream('ws-1', entry({ status: 'queued' })), { now: 0 })
    expect(events).toEqual([
      {
        kind: 'workstream.created',
        key: 'ws:ws-1:new',
        label: 'New queued work stream ws-1 "Ship it"',
        workStreamId: 'ws-1',
        squadId: 'sq',
        title: 'Ship it',
        status: 'queued',
      },
    ])
  })

  it('does not report a newly seen terminal stream', () => {
    expect(diffSnapshots(empty(), withStream('ws-1', entry({ status: 'done' })), { now: 0 })).toEqual([])
  })

  it('reports transitions into done and canceled but not into active', () => {
    const prev = withStream('ws-1', entry({ status: 'queued' }))
    expect(kinds(diffSnapshots(prev, withStream('ws-1', entry({ status: 'active' })), { now: 0 }))).toEqual([])
    expect(diffSnapshots(prev, withStream('ws-1', entry({ status: 'done' })), { now: 0 })).toEqual([
      {
        kind: 'workstream.done',
        key: 'ws:ws-1:done',
        label: 'Work stream ws-1 "Ship it" is done',
        workStreamId: 'ws-1',
        squadId: 'sq',
        title: 'Ship it',
      },
    ])
    expect(kinds(diffSnapshots(prev, withStream('ws-1', entry({ status: 'canceled' })), { now: 0 }))).toEqual([
      'workstream.canceled',
    ])
  })

  it('reports a new or changed open wait and stays silent for an unchanged one', () => {
    const wait = { hash: 'h1', type: 'review', message: 'Merge #12' }
    const prev = withStream('ws-1', entry())
    const next = withStream('ws-1', entry({ waits: { 'w-1': wait } }))
    expect(diffSnapshots(prev, next, { now: 0 })).toEqual([
      {
        kind: 'workstream.wait',
        key: 'ws:ws-1:wait:w-1:h1',
        label: 'Work stream ws-1 "Ship it" has a new or changed open review wait w-1: Merge #12',
        workStreamId: 'ws-1',
        squadId: 'sq',
        title: 'Ship it',
        waitId: 'w-1',
        waitType: 'review',
        message: 'Merge #12',
      },
    ])
    expect(diffSnapshots(next, next, { now: 0 })).toEqual([])
    const changed = withStream('ws-1', entry({ waits: { 'w-1': { ...wait, hash: 'h2' } } }))
    expect(kinds(diffSnapshots(next, changed, { now: 0 }))).toEqual(['workstream.wait'])
  })

  it('a closed wait produces no event', () => {
    const prev = withStream('ws-1', entry({ waits: { 'w-1': { hash: 'h1', type: 'manual', message: null } } }))
    expect(diffSnapshots(prev, withStream('ws-1', entry()), { now: 0 })).toEqual([])
  })
})

describe('diffSnapshots — idle rule', () => {
  const idleStream = () => entry({ status: 'active', derived: 'idle', active: 0, waits: {} })

  it('is inactive without an idle state', () => {
    const snap = withStream('ws-1', idleStream())
    expect(diffSnapshots(snap, snap, { now: IDLE_MS * 2 })).toEqual([])
  })

  it('arms on first sight and fires once after IDLE_MS', () => {
    const idle: IdleState = { since: {}, notified: [] }
    const snap = withStream('ws-1', idleStream())
    expect(diffSnapshots(snap, snap, { now: 1_000, idle })).toEqual([])
    expect(idle.since['ws-1']).toBe(1_000)
    expect(diffSnapshots(snap, snap, { now: 1_000 + IDLE_MS - 1, idle })).toEqual([])
    expect(diffSnapshots(snap, snap, { now: 1_000 + IDLE_MS, idle })).toEqual([
      {
        kind: 'workstream.idle',
        key: 'ws:ws-1:idle:1000',
        label: 'Work stream ws-1 "Ship it" has been idle without running agents or waits for at least 10 minutes',
        workStreamId: 'ws-1',
        squadId: 'sq',
        title: 'Ship it',
        idleSince: new Date(1_000).toISOString(),
      },
    ])
    expect(diffSnapshots(snap, snap, { now: 1_000 + IDLE_MS * 3, idle })).toEqual([])
  })

  it('re-arms when the condition breaks', () => {
    const idle: IdleState = { since: {}, notified: [] }
    const snap = withStream('ws-1', idleStream())
    diffSnapshots(snap, snap, { now: 0, idle })
    diffSnapshots(snap, snap, { now: IDLE_MS, idle })
    expect(idle.notified).toEqual(['ws-1'])
    const busy = withStream('ws-1', entry({ derived: 'in_progress', active: 1 }))
    diffSnapshots(snap, busy, { now: IDLE_MS + 1, idle })
    expect(idle.since).toEqual({})
    expect(idle.notified).toEqual([])
    diffSnapshots(busy, snap, { now: IDLE_MS + 2, idle })
    expect(kinds(diffSnapshots(snap, snap, { now: IDLE_MS * 2 + 2, idle }))).toEqual(['workstream.idle'])
  })

  it('an open wait disqualifies idle', () => {
    const idle: IdleState = { since: {}, notified: [] }
    const snap = withStream('ws-1', idleStream())
    const waiting = withStream(
      'ws-1',
      entry({ derived: 'idle', active: 0, waits: { w: { hash: 'h', type: 'manual', message: null } } })
    )
    diffSnapshots(snap, waiting, { now: 0, idle })
    expect(idle.since).toEqual({})
  })
})

describe('diffSnapshots — actions and inbox', () => {
  it('reports new and changed pending actions with their fields', () => {
    const next: Snapshot = {
      ...empty(),
      actions: { 'a-1': { hash: 'h1', type: 'agent-question', squadId: 'sq', canRespond: true } },
    }
    expect(diffSnapshots(empty(), next, { now: 0 })).toEqual([
      {
        kind: 'action.pending',
        key: 'action:a-1:h1',
        label: 'New or updated pending agent-question action a-1',
        actionId: 'a-1',
        type: 'agent-question',
        squadId: 'sq',
        canRespond: true,
      },
    ])
    expect(diffSnapshots(next, next, { now: 0 })).toEqual([])
    const changed: Snapshot = { ...next, actions: { 'a-1': { ...next.actions['a-1'], hash: 'h2' } } }
    expect(kinds(diffSnapshots(next, changed, { now: 0 }))).toEqual(['action.pending'])
  })

  it('reports new and changed inbox messages from any sender', () => {
    const next: Snapshot = {
      ...empty(),
      inbox: {
        'm-1': { hash: 'h1', senderType: 'agent', senderId: 'ag', subject: 'Done' },
        'm-2': { hash: 'h2', senderType: 'system', senderId: null, subject: 'Fleet alert' },
      },
    }
    expect(diffSnapshots(empty(), next, { now: 0 })).toEqual([
      {
        kind: 'inbox.message',
        key: 'inbox:m-1:h1',
        label: 'New or updated inbox message m-1 from agent ag: Done',
        messageId: 'm-1',
        senderType: 'agent',
        senderId: 'ag',
        subject: 'Done',
      },
      {
        kind: 'inbox.message',
        key: 'inbox:m-2:h2',
        label: 'New or updated inbox message m-2 from system: Fleet alert',
        messageId: 'm-2',
        senderType: 'system',
        senderId: null,
        subject: 'Fleet alert',
      },
    ])
  })

  it('a message that disappears (read) produces no event', () => {
    const prev: Snapshot = {
      ...empty(),
      inbox: { 'm-1': { hash: 'h1', senderType: 'agent', senderId: 'ag', subject: null } },
    }
    expect(diffSnapshots(prev, empty(), { now: 0 })).toEqual([])
  })
})

describe('diffSnapshots — keys', () => {
  it('identical snapshots produce no events, and keys are stable across runs', () => {
    const wait = { hash: 'h1', type: 'review', message: null }
    const next = withStream('ws-1', entry({ waits: { 'w-1': wait } }))
    const a = diffSnapshots(empty(), next, { now: 0 }).map((e) => e.key)
    const b = diffSnapshots(empty(), next, { now: 99 }).map((e) => e.key)
    expect(a).toEqual(b)
    expect(a).toEqual(['ws:ws-1:new', 'ws:ws-1:wait:w-1:h1'])
  })
})
