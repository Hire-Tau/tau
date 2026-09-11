import type { Snapshot } from './snapshot'

/** A stream that is active with no execution and no open wait for this long is worth a wake-up. */
export const IDLE_MS = 10 * 60_000

/** Owned by the runner across snapshots; only --follow supplies it. */
export interface IdleState {
  since: Record<string, number>
  notified: string[]
}

interface Base {
  key: string
  label: string
}
interface StreamRef {
  workStreamId: string
  squadId: string
  title: string
}

export type WatchEvent =
  | (Base & StreamRef & { kind: 'workstream.created'; status: string })
  | (Base & StreamRef & { kind: 'workstream.done' | 'workstream.canceled' })
  | (Base & StreamRef & { kind: 'workstream.wait'; waitId: string; waitType: string; message: string | null })
  | (Base & StreamRef & { kind: 'workstream.idle'; idleSince: string })
  | (Base & { kind: 'action.pending'; actionId: string; type: string; squadId: string | null; canRespond: boolean })
  | (Base & { kind: 'inbox.message'; messageId: string; senderId: string | null; subject: string | null })
  | (Base & { kind: 'health.degraded'; error: string })
  | (Base & { kind: 'health.recovered' })

const OPEN_STATUSES = new Set(['active', 'queued'])
const TERMINAL_STATUSES = new Set(['done', 'canceled'])

export function diffSnapshots(prev: Snapshot, next: Snapshot, ctx: { now: number; idle?: IdleState }): WatchEvent[] {
  const events: WatchEvent[] = []

  for (const [id, s] of Object.entries(next.streams)) {
    const old = prev.streams[id]
    const ref: StreamRef = { workStreamId: id, squadId: s.squadId, title: s.title }
    const name = `Work stream ${id} "${s.title}"`
    if (!old && OPEN_STATUSES.has(s.status)) {
      events.push({
        kind: 'workstream.created',
        key: `ws:${id}:new`,
        label: `New ${s.status} work stream ${id} "${s.title}"`,
        ...ref,
        status: s.status,
      })
    }
    if (old && old.status !== s.status && TERMINAL_STATUSES.has(s.status)) {
      events.push({
        kind: s.status === 'done' ? 'workstream.done' : 'workstream.canceled',
        key: `ws:${id}:${s.status}`,
        label: `${name} is ${s.status}`,
        ...ref,
      })
    }
    for (const [waitId, w] of Object.entries(s.waits)) {
      if (old?.waits[waitId]?.hash === w.hash) continue
      events.push({
        kind: 'workstream.wait',
        key: `ws:${id}:wait:${waitId}:${w.hash}`,
        label: `${name} has a new or changed open ${w.type} wait ${waitId}${w.message ? `: ${w.message}` : ''}`,
        ...ref,
        waitId,
        waitType: w.type,
        message: w.message,
      })
    }
    if (ctx.idle) {
      const idle = ctx.idle
      const isIdle =
        s.status === 'active' && s.derived === 'idle' && s.active === 0 && Object.keys(s.waits).length === 0
      if (isIdle) {
        idle.since[id] ??= ctx.now
        if (ctx.now - idle.since[id] >= IDLE_MS && !idle.notified.includes(id)) {
          events.push({
            kind: 'workstream.idle',
            key: `ws:${id}:idle:${idle.since[id]}`,
            label: `${name} has been idle without running agents or waits for at least 10 minutes`,
            ...ref,
            idleSince: new Date(idle.since[id]).toISOString(),
          })
          idle.notified.push(id)
        }
      } else {
        delete idle.since[id]
        idle.notified = idle.notified.filter((x) => x !== id)
      }
    }
  }

  for (const [id, a] of Object.entries(next.actions)) {
    if (prev.actions[id]?.hash === a.hash) continue
    events.push({
      kind: 'action.pending',
      key: `action:${id}:${a.hash}`,
      label: `New or updated pending ${a.type} action ${id}`,
      actionId: id,
      type: a.type,
      squadId: a.squadId,
      canRespond: a.canRespond,
    })
  }

  for (const [id, m] of Object.entries(next.inbox)) {
    if (prev.inbox[id]?.hash === m.hash) continue
    events.push({
      kind: 'inbox.message',
      key: `inbox:${id}:${m.hash}`,
      label: `New or updated inbox message ${id} from agent ${m.senderId ?? 'unknown'}${m.subject ? `: ${m.subject}` : ''}`,
      messageId: id,
      senderId: m.senderId,
      subject: m.subject,
    })
  }

  return events
}

export function healthDegraded(error: string): WatchEvent {
  return {
    kind: 'health.degraded',
    key: 'health:degraded',
    label: `Snapshot polling failed three consecutive times: ${error}`,
    error,
  }
}

export function healthRecovered(): WatchEvent {
  return { kind: 'health.recovered', key: 'health:recovered', label: 'Snapshot polling recovered' }
}
