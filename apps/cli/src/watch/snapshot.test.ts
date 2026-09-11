import { describe, expect, it, mock } from 'bun:test'
import { apiGet } from '../client'
import { fetchSnapshot, hashValue, normalizeSnapshot } from './snapshot'

const stream = (over: Record<string, unknown> = {}) => ({
  id: 'ws-1',
  squadId: 'sq-1',
  title: 'Ship it',
  status: 'active',
  derivedState: 'in_review',
  runtime: { totalMs: 10, activeCount: 1, computedAt: 'x' },
  openWaits: [{ id: 'w-1', type: 'review', message: 'Merge #12', completesOnApproval: true }],
  ...over,
})

describe('normalizeSnapshot', () => {
  it('keys streams by id and hashes each open wait by type, message, completesOnApproval', () => {
    const snap = normalizeSnapshot({ streams: [stream()], actions: [], inbox: [] }, {})
    expect(Object.keys(snap.streams)).toEqual(['ws-1'])
    const s = snap.streams['ws-1']
    expect(s.status).toBe('active')
    expect(s.derived).toBe('in_review')
    expect(s.active).toBe(1)
    expect(s.squadId).toBe('sq-1')
    expect(s.title).toBe('Ship it')
    expect(s.waits['w-1']).toEqual({
      hash: hashValue(['review', 'Merge #12', true]),
      type: 'review',
      message: 'Merge #12',
    })
  })

  it('defaults missing runtime/derivedState/openWaits', () => {
    const snap = normalizeSnapshot(
      { streams: [stream({ runtime: undefined, derivedState: undefined, openWaits: undefined })], actions: [], inbox: [] },
      {}
    )
    expect(snap.streams['ws-1'].active).toBe(0)
    expect(snap.streams['ws-1'].derived).toBeNull()
    expect(snap.streams['ws-1'].waits).toEqual({})
  })

  it('hashes actions by type and question/message payload and skips workstream-review/blocked', () => {
    const snap = normalizeSnapshot(
      {
        streams: [],
        actions: [
          { id: 'a-q', type: 'agent-question', squadId: 'sq-1', canRespond: true, data: { questionData: { q: 1 } } },
          { id: 'a-e', type: 'agent-error', canRespond: false, data: { reason: 'boom' } },
          { id: 'a-r', type: 'workstream-review', squadId: 'sq-1', canRespond: true, data: {} },
          { id: 'a-b', type: 'workstream-blocked', squadId: 'sq-1', canRespond: true, data: {} },
        ],
        inbox: [],
      },
      {}
    )
    expect(Object.keys(snap.actions).sort()).toEqual(['a-e', 'a-q'])
    expect(snap.actions['a-q']).toEqual({
      hash: hashValue(['agent-question', { q: 1 }]),
      type: 'agent-question',
      squadId: 'sq-1',
      canRespond: true,
    })
    expect(snap.actions['a-e']).toEqual({
      hash: hashValue(['agent-error', 'boom']),
      type: 'agent-error',
      squadId: null,
      canRespond: false,
    })
  })

  it('keeps only agent-sent inbox messages, hashed by subject and content', () => {
    const snap = normalizeSnapshot(
      {
        streams: [],
        actions: [],
        inbox: [
          { id: 'm-1', senderType: 'agent', senderId: 'ag-1', subject: 'Done', content: 'PR up', metadata: {} },
          { id: 'm-2', senderType: 'user', senderId: 'u-1', subject: null, content: 'hi', metadata: {} },
          { id: 'm-3', senderType: 'system', senderId: null, subject: 'x', content: 'y', metadata: {} },
        ],
      },
      {}
    )
    expect(Object.keys(snap.inbox)).toEqual(['m-1'])
    expect(snap.inbox['m-1']).toEqual({ hash: hashValue(['Done', 'PR up']), senderId: 'ag-1', subject: 'Done' })
  })

  it('applies the squad filter to actions and inbox metadata', () => {
    const snap = normalizeSnapshot(
      {
        streams: [],
        actions: [
          { id: 'a-1', type: 'agent-question', squadId: 'sq-1', canRespond: true, data: { questionData: {} } },
          { id: 'a-2', type: 'agent-question', squadId: 'sq-2', canRespond: true, data: { questionData: {} } },
        ],
        inbox: [
          { id: 'm-1', senderType: 'agent', senderId: 'ag', subject: null, content: 'a', metadata: { squadId: 'sq-1' } },
          { id: 'm-2', senderType: 'agent', senderId: 'ag', subject: null, content: 'b', metadata: { squadId: 'sq-2' } },
          { id: 'm-3', senderType: 'agent', senderId: 'ag', subject: null, content: 'c', metadata: {} },
        ],
      },
      { squadId: 'sq-1' }
    )
    expect(Object.keys(snap.actions)).toEqual(['a-1'])
    expect(Object.keys(snap.inbox)).toEqual(['m-1'])
  })

  it('fetchSnapshot unwraps paginated {items} envelopes and passes the squad filter', async () => {
    const get = apiGet as ReturnType<typeof mock>
    get.mockReset()
    get.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/workstreams')) return [stream()]
      if (path === '/api/actions/pending') return []
      if (path.startsWith('/api/inbox/user/me')) {
        return {
          items: [{ id: 'm-1', senderType: 'agent', senderId: 'ag', subject: null, content: 'x', metadata: { squadId: 'sq-1' } }],
          hasMore: false,
          nextCursor: null,
          totalCount: 1,
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    const snap = await fetchSnapshot({ squadId: 'sq-1' })
    expect(get).toHaveBeenCalledWith('/api/workstreams?statuses=active%2Cqueued&squadId=sq-1')
    expect(Object.keys(snap.streams)).toEqual(['ws-1'])
    expect(Object.keys(snap.inbox)).toEqual(['m-1'])
  })

  it('produces key order independent of input order (stable cursors)', () => {
    const a = normalizeSnapshot({ streams: [stream({ id: 'b' }), stream({ id: 'a' })], actions: [], inbox: [] }, {})
    const b = normalizeSnapshot({ streams: [stream({ id: 'a' }), stream({ id: 'b' })], actions: [], inbox: [] }, {})
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
