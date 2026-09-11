import type { StreamEvent } from '@tau/shared'
import { createStreamingBlockState, reduceStreamingBlocks, type StreamingBlockState } from './blocks'
import type { CompactionState, StreamGroupSnapshot, SystemMessageItem } from './types'

interface MutableGroup {
  streamGroupId: string
  agentId: string
  executionId?: string
  state: StreamingBlockState
  startedAt: number
  done: boolean
  doneMessageIds: string[] | null
  flushed: boolean
  errored: boolean
}

/** Events that carry a streamGroupId and feed the block accumulator. */
function streamGroupIdOf(event: StreamEvent): string | undefined {
  return 'streamGroupId' in event ? event.streamGroupId : undefined
}

/** A full catchup may extend local blocks, but must not roll back content already shown. */
function includesLocalProgress(replayed: StreamingBlockState, local: StreamingBlockState): boolean {
  if (replayed.blocks.length < local.blocks.length) return false
  return local.blocks.every((block, index) => {
    const candidate = replayed.blocks[index]
    if (candidate.type !== block.type) return false
    if (block.type === 'text' || block.type === 'thinking') {
      return candidate.type === block.type && candidate.content.startsWith(block.content)
    }
    return (
      candidate.type === 'tool_use' &&
      candidate.toolCall.toolCallId === block.toolCall.toolCallId &&
      candidate.toolCall.toolName === block.toolCall.toolName &&
      candidate.toolCall.args.startsWith(block.toolCall.args) &&
      (!block._done ||
        (candidate._done &&
          candidate.toolCall.result === block.toolCall.result &&
          candidate.toolCall.isError === block.toolCall.isError))
    )
  })
}

/**
 * Stateful router from the SSE event stream to per-streamGroupId block
 * accumulators. The only mutable piece of the reconciliation layer; everything
 * downstream (groupPersisted/combine) is pure over snapshot().
 */
export class StreamGroupStore {
  private groups = new Map<string, MutableGroup>()
  /** The agentId most recently seen on an `agent` event, stamped onto new groups. */
  private agentId = ''
  /** The execution most recently announced by an `agent` event. */
  private executionId: string | undefined
  /** The streamGroupId of the most recent delta — flush_agent targets it. */
  private lastActive: string | null = null
  private systemMsgs: SystemMessageItem[] = []
  private compaction: CompactionState = null
  private systemMsgCounter = 0

  ingest(event: StreamEvent, now: number = Date.now()): void {
    if (event.type === 'agent') {
      this.agentId = event.agentId
      this.executionId = event.executionId
      return
    }

    if (event.type === 'flush_agent') {
      if (this.lastActive) {
        const g = this.groups.get(this.lastActive)
        if (g) g.flushed = true
      }
      return
    }

    if (event.type === 'done') {
      const id = event.streamGroupId ?? this.lastActive
      if (!id) return
      const g = this.ensure(id, now)
      g.done = true
      g.doneMessageIds = event.messageIds ?? (event.messageId ? [event.messageId] : [])
      return
    }

    if (event.type === 'error') {
      if (this.lastActive) {
        const g = this.groups.get(this.lastActive)
        if (g) g.errored = true
      }
      return
    }

    if (event.type === 'compaction_start') {
      this.compaction = { reason: event.reason }
      return
    }
    if (event.type === 'compaction_end') {
      this.compaction = null
      return
    }
    if (event.type === 'system_message') {
      // While compacting, the banner (compactionState) represents status — don't also add inline.
      if (this.compaction === null) {
        this.systemMsgCounter += 1
        this.systemMsgs.push({
          id: `sys-${this.systemMsgCounter}`,
          text: event.text,
          transientId: event.transientId,
          at: now,
        })
      }
      return
    }

    if (event.type === 'system_message_clear') {
      this.systemMsgs = this.systemMsgs.filter((m) => m.transientId !== event.transientId)
      return
    }

    const id = streamGroupIdOf(event)
    if (!id) return // other non-streamGroupId events are not block deltas
    const g = this.ensure(id, now)
    g.state = reduceStreamingBlocks(g.state, event, now)
    this.lastActive = id
  }

  /**
   * Apply a catchup batch idempotently. Terminal or empty groups touched by the batch are reset to a
   * fresh accumulator and replayed. Active groups accept a replay that includes their local
   * progress, filling disconnect gaps while preserving newer content against stale snapshots.
   */
  applyCatchup(events: StreamEvent[], now: number = Date.now()): void {
    const replay = new StreamGroupStore()
    for (const [index, event] of events.entries()) replay.ingest(event, now + index)
    const touched = new Set<string>()
    for (const e of events) {
      const id = e.type === 'done' ? (e.streamGroupId ?? undefined) : streamGroupIdOf(e)
      if (id) touched.add(id)
    }
    const protectedActive = new Set<string>()
    for (const id of touched) {
      const existing = this.groups.get(id)
      if (existing) {
        const hasLocalBlocks = existing.state.blocks.length > 0
        const isActive = !existing.done && !existing.errored && !existing.flushed
        const replayed = replay.groups.get(id)
        if (isActive && hasLocalBlocks && (!replayed || !includesLocalProgress(replayed.state, existing.state))) {
          // An older or incomplete snapshot must not retract local text/tool completion.
          protectedActive.add(id)
          continue
        }
        // Catchup is authoritative for terminal/empty groups: replace the whole group (spec §6),
        // preserving only identity + start time. Flags are re-derived from the replayed batch.
        existing.state = createStreamingBlockState()
        existing.done = false
        existing.doneMessageIds = null
        existing.flushed = false
        existing.errored = false
      }
    }
    // Preserve the original timestamps of system messages we've already seen. Catchup replays them
    // in the same order, so position i maps 1:1. Without this, a reconnect re-stamps them to `now`,
    // which sorts them BELOW the streaming bubble (whose startedAt is preserved) — making turn-start
    // notices like a provider switch-back jump under the live response.
    const prevSysAt = this.systemMsgs.map((s) => s.at)
    this.systemMsgs = []
    this.compaction = null
    this.systemMsgCounter = 0
    // Replay with order-preserving timestamps (now + index) so a system message emitted before a
    // group's first delta sorts above that group even on the first catchup, where both are new.
    events.forEach((e, i) => {
      const id = e.type === 'done' ? undefined : streamGroupIdOf(e)
      if (id && protectedActive.has(id)) {
        this.lastActive = id
        return
      }
      this.ingest(e, now + i)
    })
    for (let i = 0; i < this.systemMsgs.length && i < prevSysAt.length; i++) {
      this.systemMsgs[i].at = prevSysAt[i]
    }
  }

  /** Remove one group by id, or all groups when called with no argument (does not clear agentId — use reset() for full teardown). */
  clear(streamGroupId?: string): void {
    if (streamGroupId === undefined) {
      this.groups.clear()
      this.lastActive = null
      return
    }
    this.groups.delete(streamGroupId)
    if (this.lastActive === streamGroupId) this.lastActive = null
  }

  reset(): void {
    this.groups.clear()
    this.agentId = ''
    this.executionId = undefined
    this.lastActive = null
    this.systemMsgs = []
    this.compaction = null
    this.systemMsgCounter = 0
  }

  systemMessages(): SystemMessageItem[] {
    return this.systemMsgs
  }

  compactionState(): CompactionState {
    return this.compaction
  }

  snapshot(): StreamGroupSnapshot[] {
    return [...this.groups.values()]
      .map((g) => ({
        streamGroupId: g.streamGroupId,
        agentId: g.agentId,
        executionId: g.executionId,
        blocks: g.state.blocks,
        startedAt: g.startedAt,
        done: g.done,
        doneMessageIds: g.doneMessageIds,
        flushed: g.flushed,
        errored: g.errored,
      }))
      .sort((a, b) => a.startedAt - b.startedAt || (a.streamGroupId < b.streamGroupId ? -1 : 1))
  }

  private ensure(streamGroupId: string, now: number): MutableGroup {
    let g = this.groups.get(streamGroupId)
    if (!g) {
      g = {
        streamGroupId,
        agentId: this.agentId,
        executionId: this.executionId,
        state: createStreamingBlockState(),
        startedAt: now,
        done: false,
        doneMessageIds: null,
        flushed: false,
        errored: false,
      }
      this.groups.set(streamGroupId, g)
    }
    return g
  }
}
