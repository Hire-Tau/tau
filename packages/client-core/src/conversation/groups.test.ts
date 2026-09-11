import { describe, expect, test } from 'bun:test'
import type { StreamEvent } from '@tau/shared'
import { StreamGroupStore } from './groups'

const agent: StreamEvent = { type: 'agent', agentId: 'a1' }

describe('StreamGroupStore', () => {
  test('routes deltas to a group keyed by streamGroupId', () => {
    const store = new StreamGroupStore()
    store.ingest(agent, 100)
    store.ingest({ type: 'text', text: 'Hi', streamGroupId: 'S1' }, 100)
    const snaps = store.snapshot()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].streamGroupId).toBe('S1')
    expect(snaps[0].agentId).toBe('a1')
    expect(snaps[0].startedAt).toBe(100)
    expect(snaps[0].blocks.map((b) => b.type)).toEqual(['text'])
    expect(snaps[0].done).toBe(false)
  })

  test('separate streamGroupIds form separate groups', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'a', streamGroupId: 'S1' }, 1)
    store.ingest({ type: 'text', text: 'b', streamGroupId: 'S2' }, 2)
    expect(store.snapshot().map((s) => s.streamGroupId)).toEqual(['S1', 'S2'])
  })

  test('done marks the group and records messageIds', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'a', streamGroupId: 'S1' }, 1)
    store.ingest({ type: 'done', response: 'a', streamGroupId: 'S1', messageIds: ['m1', 'm2'] }, 2)
    const s = store.snapshot()[0]
    expect(s.done).toBe(true)
    expect(s.doneMessageIds).toEqual(['m1', 'm2'])
  })

  test('flush_agent marks the most recent active group flushed but keeps its blocks', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'partial', streamGroupId: 'S1' }, 1)
    store.ingest({ type: 'flush_agent' }, 2)
    const s = store.snapshot()[0]
    expect(s.flushed).toBe(true)
    expect(s.blocks.map((b) => b.type)).toEqual(['text'])
  })

  test('error marks the group errored', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'a', streamGroupId: 'S1' }, 1)
    store.ingest({ type: 'error', message: 'boom' }, 2)
    expect(store.snapshot()[0].errored).toBe(true)
  })

  test('applyCatchup is idempotent: replaying twice converges to the same blocks', () => {
    const events: StreamEvent[] = [
      { type: 'text', text: 'Hel', streamGroupId: 'S1' },
      { type: 'text', text: 'lo', streamGroupId: 'S1' },
    ]
    const store = new StreamGroupStore()
    store.applyCatchup(events, 1)
    const first = store.snapshot()[0].blocks
    store.applyCatchup(events, 1) // reconnect replays the same batch
    const second = store.snapshot()[0].blocks
    expect(second).toEqual(first)
    expect(second.map((b) => (b.type === 'text' ? b.content : ''))).toEqual(['Hello'])
  })

  test('applyCatchup preserves the original startedAt for a known group', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'a', streamGroupId: 'S1' }, 100)
    store.applyCatchup([{ type: 'text', text: 'a', streamGroupId: 'S1' }], 999)
    expect(store.snapshot()[0].startedAt).toBe(100)
  })

  test('applyCatchup does not replace an active group with a stale partial replay', () => {
    const store = new StreamGroupStore()
    store.ingest(agent, 1)
    store.ingest({ type: 'tool_start', toolCallId: 'tool-1', toolName: 'search', args: '{}', streamGroupId: 'S1' }, 2)
    store.ingest({ type: 'tool_end', toolCallId: 'tool-1', result: 'ok', isError: false, streamGroupId: 'S1' }, 3)
    store.ingest({ type: 'text', text: 'Final message prefix', streamGroupId: 'S1' }, 4)

    const before = store.snapshot()[0]
    store.applyCatchup([{ type: 'text', text: 'Final ', streamGroupId: 'S1' }], 999)

    const after = store.snapshot()[0]
    expect(after.startedAt).toBe(before.startedAt)
    expect(after.done).toBe(false)
    expect(after.blocks).toEqual(before.blocks)
  })

  test('applyCatchup keeps a turn-start system message above the streaming bubble on reconnect', () => {
    const events: StreamEvent[] = [
      { type: 'agent', agentId: 'a' },
      { type: 'system_message', text: 'Recovered provider available — switched back' },
      { type: 'text', text: 'hello', streamGroupId: 'S1' },
    ]
    const store = new StreamGroupStore()
    // Live: the system message is pushed before the group's first delta → sorts above it.
    store.ingest(events[0], 100)
    store.ingest(events[1], 101)
    store.ingest(events[2], 102)
    expect(store.systemMessages()[0].at).toBeLessThanOrEqual(store.snapshot()[0].startedAt)
    // Reconnect replays the same batch at a much later `now`. The bubble keeps startedAt=102, and the
    // system message must NOT be re-stamped to `now` and shoved below it.
    store.applyCatchup(events, 999_999)
    expect(store.snapshot()[0].startedAt).toBe(102)
    expect(store.systemMessages()[0].at).toBeLessThanOrEqual(store.snapshot()[0].startedAt)
  })

  test('applyCatchup orders a turn-start system message above a newly-seen group (first catchup)', () => {
    const events: StreamEvent[] = [
      { type: 'agent', agentId: 'a' },
      { type: 'system_message', text: 'switched back' },
      { type: 'text', text: 'hi', streamGroupId: 'S1' },
    ]
    const store = new StreamGroupStore()
    store.applyCatchup(events, 1000) // first time seen; all new
    expect(store.systemMessages()[0].at).toBeLessThan(store.snapshot()[0].startedAt)
  })

  test('clear(S) removes one group; reset() removes all', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'a', streamGroupId: 'S1' }, 1)
    store.ingest({ type: 'text', text: 'b', streamGroupId: 'S2' }, 2)
    store.clear('S1')
    expect(store.snapshot().map((s) => s.streamGroupId)).toEqual(['S2'])
    store.reset()
    expect(store.snapshot()).toEqual([])
  })

  test('snapshot returns groups in startedAt order with a stable tiebreak', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'b', streamGroupId: 'B' }, 5)
    store.ingest({ type: 'text', text: 'a', streamGroupId: 'A' }, 5)
    expect(store.snapshot().map((s) => s.streamGroupId)).toEqual(['A', 'B'])
  })

  test('done without streamGroupId falls back to the last-active group', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'a', streamGroupId: 'S1' }, 1)
    store.ingest({ type: 'done', response: 'a', messageIds: ['m1'] }, 2) // no streamGroupId
    const s = store.snapshot()[0]
    expect(s.done).toBe(true)
    expect(s.doneMessageIds).toEqual(['m1'])
  })

  test('applyCatchup is authoritative: a batch lacking a prior done resets the done flag', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'a', streamGroupId: 'S1' }, 1)
    store.ingest({ type: 'done', response: 'a', streamGroupId: 'S1', messageIds: ['m1'] }, 2)
    expect(store.snapshot()[0].done).toBe(true)
    // Reconnect delivers a catchup that only has the text (no done) → group is no longer done.
    store.applyCatchup([{ type: 'text', text: 'a', streamGroupId: 'S1' }], 1)
    const s = store.snapshot()[0]
    expect(s.done).toBe(false)
    expect(s.doneMessageIds).toBeNull()
    expect(s.startedAt).toBe(1) // original start time preserved
  })
})

describe('StreamGroupStore — system messages & compaction', () => {
  test('accumulates system_message as ordered SystemMessageItems', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'system_message', text: 'Retrying (attempt 1/3)' }, 10)
    store.ingest({ type: 'system_message', text: 'Switched model' }, 20)
    const msgs = store.systemMessages()
    expect(msgs.map((m) => m.text)).toEqual(['Retrying (attempt 1/3)', 'Switched model'])
    expect(msgs.map((m) => m.at)).toEqual([10, 20])
    expect(new Set(msgs.map((m) => m.id)).size).toBe(2) // unique ids
  })

  test('system_message_clear removes matching transient system messages', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'system_message', text: 'Retrying (attempt 1/3)', transientId: 'auto-retry' }, 10)
    store.ingest({ type: 'system_message', text: 'Switched model' }, 20)

    store.ingest({ type: 'system_message_clear', transientId: 'auto-retry' }, 30)

    expect(store.systemMessages().map((m) => m.text)).toEqual(['Switched model'])
  })

  test('compaction_start sets compactionState; compaction_end clears it', () => {
    const store = new StreamGroupStore()
    expect(store.compactionState()).toBeNull()
    store.ingest({ type: 'compaction_start', reason: 'auto' }, 1)
    expect(store.compactionState()).toEqual({ reason: 'auto' })
    store.ingest({ type: 'compaction_end', success: true, aborted: false }, 2)
    expect(store.compactionState()).toBeNull()
  })

  test('system_message during compaction is NOT added inline (banner covers it)', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'compaction_start', reason: 'manual' }, 1)
    store.ingest({ type: 'system_message', text: 'Compacting context (manual)...' }, 2)
    expect(store.systemMessages()).toEqual([]) // suppressed while compacting
    store.ingest({ type: 'compaction_end', success: true, aborted: false }, 3)
    store.ingest({ type: 'system_message', text: 'Context compacted — continuing...' }, 4)
    expect(store.systemMessages().map((m) => m.text)).toEqual(['Context compacted — continuing...'])
  })

  test('reset() clears system messages and compaction state', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'system_message', text: 'x' }, 1)
    store.ingest({ type: 'compaction_start', reason: 'auto' }, 2)
    store.reset()
    expect(store.systemMessages()).toEqual([])
    expect(store.compactionState()).toBeNull()
  })

  test('applyCatchup is idempotent for system messages (no duplicates on reconnect)', () => {
    const events = [
      { type: 'system_message', text: 'Retrying (attempt 1/3)' },
      { type: 'system_message', text: 'Done retrying' },
    ] as const
    const store = new StreamGroupStore()
    store.applyCatchup([...events], 5)
    store.applyCatchup([...events], 5) // reconnect replays the same batch
    expect(store.systemMessages().map((m) => m.text)).toEqual(['Retrying (attempt 1/3)', 'Done retrying'])
  })

  test('stamps execution identity on each new stream group without rewriting existing groups', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'agent', agentId: 'a1', executionId: 'e1' }, 1)
    store.ingest({ type: 'text', text: 'one', streamGroupId: 'g1' }, 2)
    store.ingest({ type: 'agent', agentId: 'a1', executionId: 'e2' }, 3)
    store.ingest({ type: 'text', text: 'two', streamGroupId: 'g2' }, 4)

    expect(store.snapshot()).toMatchObject([
      { executionId: 'e1', streamGroupId: 'g1' },
      { executionId: 'e2', streamGroupId: 'g2' },
    ])
  })

  test('keeps legacy groups without inferred execution identity', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'agent', agentId: 'a1' }, 1)
    store.ingest({ type: 'text', text: 'one', streamGroupId: 'e1:not-parsed' }, 2)

    expect(store.snapshot()[0].executionId).toBeUndefined()
  })
})

describe('catchup fills disconnect gaps without retracting local progress', () => {
  test('newer active text replay fills missed tokens exactly once before live streaming resumes', () => {
    const store = new StreamGroupStore()
    store.ingest({ type: 'text', text: 'Hello', streamGroupId: 'S' }, 1)
    const catchup: StreamEvent[] = [{ type: 'text', text: 'Hello world', streamGroupId: 'S' }]
    store.applyCatchup(catchup, 2)
    store.applyCatchup(catchup, 3)
    store.ingest({ type: 'text', text: '!', streamGroupId: 'S' }, 4)
    expect(store.snapshot()[0].blocks).toMatchObject([{ content: 'Hello world!' }])
    expect(store.snapshot()[0].startedAt).toBe(1)
  })

  test('catchup includes tool completion and subsequent text missed while disconnected', () => {
    const start: StreamEvent = {
      type: 'tool_start',
      toolCallId: 't1',
      toolName: 'search',
      args: '{}',
      streamGroupId: 'S',
    }
    const store = new StreamGroupStore()
    store.ingest(start, 1)
    const events: StreamEvent[] = [
      start,
      { type: 'tool_end', toolCallId: 't1', result: 'found', isError: false, streamGroupId: 'S' },
      { type: 'text', text: 'answer', streamGroupId: 'S' },
    ]
    store.applyCatchup(events, 2)
    expect(store.snapshot()[0].blocks).toMatchObject([
      { _done: true, toolCall: { result: 'found' } },
      { content: 'answer' },
    ])
    // A later connection with a stale prefix must preserve completed content.
    store.applyCatchup([start], 3)
    expect(store.snapshot()[0].blocks).toMatchObject([
      { _done: true, toolCall: { result: 'found' } },
      { content: 'answer' },
    ])
  })
})
