import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, messages } from '../../db/schema'
import { messageSortAtSql, visibleMessageSql } from '../../entities/message-time'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('agent-activity-summary')

/** Either the root client or a transaction — every writer composes into callers' transactions. */
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Chars of the newest delivered message kept for the conversation preview. */
export const ACTIVITY_PREVIEW_CHARS = 280

/**
 * Compare the newest human and assistant candidates, then fetch only the winning
 * preview. Human consumption timestamps still need parsing; scan that smaller
 * set once, never the assistant transcript. The assistant index lookup finds the
 * newest millisecond, then chooses its greatest id (raw microseconds must not
 * break ties differently from messageSortAtSql).
 */
export function agentActivitySummarySql(agentId: string) {
  return sql`
    WITH assistant_latest AS MATERIALIZED (
      SELECT date_trunc('milliseconds', ${messages.createdAt}) AS sort_at
      FROM ${messages}
      WHERE ${messages.agentId} = ${agentId}
        AND ${messages.role} = 'assistant' AND ${visibleMessageSql}
      ORDER BY ${messages.createdAt} DESC LIMIT 1
    ), assistant_bucket AS MATERIALIZED (
      SELECT ${messages.id} AS id, ${messages.role} AS role, assistant_latest.sort_at
      FROM ${messages}, assistant_latest
      WHERE ${messages.agentId} = ${agentId}
        AND ${messages.role} = 'assistant' AND ${visibleMessageSql}
        AND ${messages.createdAt} >= assistant_latest.sort_at
        AND ${messages.createdAt} < assistant_latest.sort_at + interval '1 millisecond'
    ), candidates AS MATERIALIZED (
      (
        SELECT ${messages.id} AS id, ${messages.role} AS role, ${messageSortAtSql} AS sort_at
        FROM ${messages}
        WHERE ${messages.agentId} = ${agentId}
          AND ${messages.role} = 'human' AND ${visibleMessageSql}
        ORDER BY ${messageSortAtSql} DESC, ${messages.id} DESC
        LIMIT 1
      )
      UNION ALL
      (
        SELECT id, role, sort_at FROM assistant_bucket ORDER BY id DESC LIMIT 1
      )
    )
    SELECT MAX(sort_at) AS last_message_at,
      MAX(sort_at) FILTER (WHERE role = 'human') AS last_human_message_at,
      (
        SELECT LEFT(${messages.content}, ${ACTIVITY_PREVIEW_CHARS})
        FROM ${messages}
        WHERE ${messages.id} = (SELECT id FROM candidates ORDER BY sort_at DESC, id DESC LIMIT 1)
      ) AS last_message_preview
    FROM candidates
  `
}

/**
 * Recompute an agent's denormalized conversation summary from its messages.
 *
 * WHY THIS EXISTS. `lastMessageAt`, `lastHumanMessageAt` and
 * `lastMessagePreview` used to be three correlated subqueries baked into
 * `agentSelectColumns`, so EVERY agent select — every hydration, every list,
 * every background sweep — evaluated three aggregates over `messages` per
 * agent row. Measured on a live tenant: 5.5 billion tuples read from a
 * 2,474-row table, ~163ms per call at 96 rows, ~18.6 hours of cumulative
 * database time, while both core processes sat pinned at ~90% of a single
 * thread and the box was 85% idle. Reads outnumber writes by orders of
 * magnitude, so the work belongs on the write side.
 *
 * WHY RECOMPUTE RATHER THAN UPDATE-IN-PLACE. The obvious optimisation — "a new
 * message is newer, so just overwrite" — is wrong here, and quietly:
 *
 *   - `messageSortAt` prefers `metadata->>'consumedAt'` over `created_at` for
 *     human messages, so an OLDER row can become the newest sort value when it
 *     is consumed, long after insert.
 *   - Only `pending = false` rows count, so a message can enter the set
 *     without being inserted, when a pending row is delivered.
 *   - Messages are deleted and rewritten in recovery paths.
 *
 * Any of those makes an incremental writer drift from the truth, and drift in
 * a denormalized column is invisible until someone compares it against the
 * source. Recompute from two candidates: an indexed assistant lookup and one
 * scan of human messages. Cost no longer grows with assistant transcript size;
 * human consumption timestamps still require scanning the human subset.
 *
 * NEVER THROWS. The summary is display metadata; a failure here must not roll
 * back the message write that triggered it. Callers that pass a transaction
 * are the exception — inside a tx the caller owns the failure, so the error
 * propagates and the whole write is retried consistently.
 */
export async function refreshAgentActivity(agentId: string, tx?: DbHandle): Promise<void> {
  const handle = tx ?? db
  const run = async () => {
    await handle.execute(sql`
      WITH summary AS (${agentActivitySummarySql(agentId)})
      UPDATE ${agents}
      SET last_message_at = summary.last_message_at,
          last_human_message_at = summary.last_human_message_at,
          last_message_preview = summary.last_message_preview
      FROM summary
      WHERE ${agents.id} = ${agentId}
    `)
  }

  if (tx) {
    // Inside a caller's transaction the caller owns the failure semantics.
    await run()
    return
  }
  try {
    await run()
  } catch (error) {
    log.warn(`Failed to refresh activity summary for agent ${agentId}`, error)
  }
}

/**
 * Refresh several agents' summaries. Used by backfills and by writes that
 * touch more than one agent's messages. Sequential on purpose: this runs on
 * the write path, and firing N concurrent updates at the pool is how a cheap
 * bookkeeping step turns into pool exhaustion.
 */
export async function refreshAgentActivityMany(agentIds: readonly string[], tx?: DbHandle): Promise<void> {
  for (const id of new Set(agentIds)) {
    await refreshAgentActivity(id, tx)
  }
}

/**
 * True when the stored summary disagrees with a fresh computation. Exported
 * for tests and for a drift check — a denormalized column with no way to prove
 * it matches its source is a bug waiting to be believed.
 */
export async function agentActivityDrift(agentId: string): Promise<boolean> {
  const [row] = await db
    .select({
      stored: agents.lastMessageAt,
      computed: sql<Date | null>`(
        SELECT MAX(${messageSortAtSql})
        FROM ${messages}
        WHERE ${messages.agentId} = ${agentId}
          AND ${visibleMessageSql}
      )`.mapWith(messages.createdAt),
    })
    .from(agents)
    .where(and(eq(agents.id, agentId)))
  if (!row) return false
  const a = row.stored?.getTime() ?? null
  const b = row.computed?.getTime() ?? null
  return a !== b
}

/**
 * Keep the denormalized summary current by subscribing to the message events
 * that already exist, rather than instrumenting every insert site.
 *
 * COVERAGE, stated because it is the whole risk of maintaining this in the
 * application rather than in a trigger:
 *
 *   `message.created`  — NOT handled here. Those five sites await
 *                        refreshAgentActivity before emitting, so a caller
 *                        that writes a message and immediately reads the agent
 *                        sees its own write. A debounced subscriber cannot
 *                        provide that: by the time it runs, the read is done.
 *   `message.updated`  — 5 emit sites in services/agent/pending-delivery.ts,
 *                        covering the pending -> delivered flip AND the
 *                        `consumedAt` stamp, which are the two mutations that
 *                        change the summary WITHOUT inserting anything.
 *
 * One mutation is NOT covered here: services/work-streams/continuation.ts sets
 * `pending: false` directly and emits nothing, so it calls
 * refreshAgentActivity itself. If you add another path that writes `messages`
 * without emitting, do the same — otherwise the column silently drifts, and a
 * denormalized column that disagrees with its source is worse than no column
 * at all. agentActivityDrift() exists to prove it has not.
 *
 * Refreshes are fire-and-forget: the summary is display metadata and must
 * never delay or fail the write that produced it.
 */
export const ACTIVITY_REFRESH_DEBOUNCE_MS = 1_000

/**
 * Per-agent trailing-edge debounce.
 *
 * `message.updated` fires on every pending-delivery transition, so one
 * streaming agent can emit a burst of events that each ask for the same
 * recompute. Undebounced that is one query per event; debounced it is at most
 * one per agent per window, and the window's cost is bounded no matter how
 * fast messages arrive.
 *
 * 1000ms, because the recompute measured 7.7ms for a median agent (20
 * messages) and 59.9ms for the largest on the tenant sampled (10,657). One
 * per second caps a continuously-active agent at well under 1% of a core, and
 * ~6% for that outlier — while a second of staleness is invisible on a list
 * the client is already receiving live over the WebSocket.
 *
 * Trailing edge on purpose: the LAST event in a burst is the one whose state
 * must survive, and a leading-edge fire would refresh before the burst's final
 * write and then coalesce away the correction.
 */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleRefresh(agentId: string): void {
  if (pending.has(agentId)) return
  pending.set(
    agentId,
    setTimeout(() => {
      pending.delete(agentId)
      void refreshAgentActivity(agentId)
    }, ACTIVITY_REFRESH_DEBOUNCE_MS)
  )
}

/**
 * Run every scheduled refresh now, clear the timers, and RESOLVE WHEN THEY
 * FINISH.
 *
 * Awaitable on purpose. A fire-and-forget flush leaves database writes in
 * flight with nothing to join them, and in a test process those land during
 * the NEXT file — after this one's fixtures are gone. That is not theoretical:
 * an earlier version leaked exactly this way and reddened an unrelated
 * execution-classification test three files later, which looked like a flake
 * and was not.
 */
export function flushPendingActivityRefreshes(): Promise<void> {
  const inFlight: Array<Promise<void>> = []
  for (const [agentId, timer] of pending) {
    clearTimeout(timer)
    inFlight.push(refreshAgentActivity(agentId))
  }
  pending.clear()
  return Promise.all(inFlight).then(() => undefined)
}

export function registerAgentActivityEventHandlers(): () => void {
  const unsubscribe = eventEmitter.onAny((event, data) => {
    // message.created is NOT handled here. Those paths refresh synchronously,
    // before the emit, because their callers read the agent straight back and
    // a debounced refresh would hand them the previous summary. This subscriber
    // exists for message.updated — the pending -> delivered flip and the
    // consumedAt stamp — which change the summary with no insert and no caller
    // waiting on the result, and which streaming emits in bursts.
    if (event !== 'message.updated') return
    const agentId = (data as { agentId?: unknown } | null)?.agentId
    if (typeof agentId !== 'string' || !agentId) return
    scheduleRefresh(agentId)
  })
  return () => {
    unsubscribe()
    // Flush rather than drop: a shutdown landing inside a debounce window
    // would otherwise leave the column a message behind until that agent's
    // next write. refreshAgentActivity never throws here, so a closing pool
    // degrades to a logged warning and self-heals on the next message.
    flushPendingActivityRefreshes()
  }
}
