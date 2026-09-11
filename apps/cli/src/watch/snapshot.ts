import { createHash } from 'node:crypto'
import { apiGet } from '../client'

export interface WaitEntry {
  hash: string
  type: string
  message: string | null
}

export interface StreamEntry {
  status: string
  derived: string | null
  active: number
  waits: Record<string, WaitEntry>
  squadId: string
  title: string
}

export interface ActionEntry {
  hash: string
  type: string
  squadId: string | null
  canRespond: boolean
}

export interface InboxEntry {
  hash: string
  senderType: string
  senderId: string | null
  subject: string | null
}

/** Normalized attention surface. Keyed maps are sorted by id so encodings are stable. */
export interface Snapshot {
  v: 1
  streams: Record<string, StreamEntry>
  actions: Record<string, ActionEntry>
  inbox: Record<string, InboxEntry>
}

export interface RawSnapshot {
  streams: unknown[]
  actions: unknown[]
  inbox: unknown[]
}

type Row = Record<string, any>

/** Pending action types whose attention is already carried by the stream's open wait. */
const WAIT_BACKED_ACTION_TYPES = new Set(['workstream-review', 'workstream-blocked'])

export function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

function sorted<T>(rows: Array<[string, T]>): Record<string, T> {
  return Object.fromEntries(rows.sort(([a], [b]) => a.localeCompare(b)))
}

export function normalizeSnapshot(raw: RawSnapshot, opts: { squadId?: string }): Snapshot {
  const squadId = opts.squadId
  const streams = sorted(
    (raw.streams as Row[]).map((s) => [
      s.id,
      {
        status: s.status,
        derived: s.derivedState ?? null,
        active: s.runtime?.activeCount ?? 0,
        waits: sorted(
          ((s.openWaits ?? []) as Row[]).map((w) => [
            w.id,
            {
              hash: hashValue([w.type, w.message, w.completesOnApproval]),
              type: w.type,
              message: w.message ?? null,
            },
          ])
        ),
        squadId: s.squadId,
        title: s.title,
      } satisfies StreamEntry,
    ])
  )
  const actions = sorted(
    (raw.actions as Row[])
      .filter((a) => !WAIT_BACKED_ACTION_TYPES.has(a.type))
      .filter((a) => !squadId || a.squadId === squadId)
      .map((a) => [
        a.id,
        {
          hash: hashValue([a.type, a.data?.questionData ?? a.data?.message ?? a.data?.reason ?? null]),
          type: a.type,
          squadId: a.squadId ?? null,
          canRespond: a.canRespond === true,
        } satisfies ActionEntry,
      ])
  )
  // Every unread message to the user counts (agents, system notices, remote peers, other humans).
  const inbox = sorted(
    (raw.inbox as Row[])
      .filter((m) => !squadId || m.metadata?.squadId === squadId)
      .map((m) => [
        m.id,
        {
          hash: hashValue([m.subject ?? null, m.content ?? '']),
          senderType: m.senderType ?? 'unknown',
          senderId: m.senderId ?? null,
          subject: m.subject ?? null,
        } satisfies InboxEntry,
      ])
  )
  return { v: 1, streams, actions, inbox }
}

/** List endpoints answer with a bare array, or `{ items }` once a `limit` makes them paginate. */
function rows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const items = (payload as { items?: unknown } | null)?.items
  return Array.isArray(items) ? items : []
}

/** Three read-only requests; the list payload already carries openWaits/derivedState/runtime. */
export async function fetchSnapshot(opts: { squadId?: string }): Promise<Snapshot> {
  const streamParams = new URLSearchParams({ statuses: 'active,queued' })
  if (opts.squadId) streamParams.set('squadId', opts.squadId)
  const [streams, actions, inbox] = await Promise.all([
    apiGet<unknown>(`/api/workstreams?${streamParams}`),
    apiGet<unknown>('/api/actions/pending'),
    apiGet<unknown>('/api/inbox/user/me?limit=200'),
  ])
  return normalizeSnapshot({ streams: rows(streams), actions: rows(actions), inbox: rows(inbox) }, opts)
}
