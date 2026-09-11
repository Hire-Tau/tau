import { describe, expect, it } from 'bun:test'
import { decodeCursor, encodeCursor } from './cursor'
import type { Snapshot } from './snapshot'

const snapshot: Snapshot = {
  v: 1,
  streams: {
    'ws-1': {
      status: 'active',
      derived: 'idle',
      active: 0,
      waits: { 'w-1': { hash: 'abc', type: 'review', message: null } },
      squadId: 'sq',
      title: 'T',
    },
  },
  actions: { 'a-1': { hash: 'def', type: 'agent-question', squadId: null, canRespond: true } },
  inbox: { 'm-1': { hash: '123', senderId: 'ag', subject: 'S' } },
}

describe('cursor', () => {
  it('round-trips a snapshot', () => {
    expect(decodeCursor(encodeCursor(snapshot))).toEqual(snapshot)
  })

  it('is url-safe', () => {
    expect(encodeCursor(snapshot)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects garbage', () => {
    expect(() => decodeCursor('not base64!!')).toThrow(/Invalid --cursor/)
  })

  it('rejects an unsupported version', () => {
    const bad = Buffer.from(JSON.stringify({ ...snapshot, v: 2 })).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(/Invalid --cursor/)
  })

  it('rejects a payload missing the maps', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1 })).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow(/Invalid --cursor/)
  })
})
