import { isLiveAgentStatus, type AgentStatus } from '@tau/shared'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../db'
import { decodeGitHubPrWorkStreamMetadata } from './github-work-stream-metadata'
import { extractGitHubPrDispatchFact, isGitHubPrDispatchFact, type GitHubPrDispatchFact } from './github-pr-fact'
import type {
  ChatExecutionSnapshot,
  ExecutionSnapshot,
  GitHubPrSnapshot,
  InboxSnapshot,
  WaitSnapshot,
  WorkStreamSnapshot,
} from './extractors'
import type { SquadActivitySourceFamily } from './types'

export type SourceSnapshot =
  | ChatExecutionSnapshot
  | ExecutionSnapshot
  | InboxSnapshot
  | WorkStreamSnapshot
  | WaitSnapshot
  | GitHubPrSnapshot
export interface ActivitySourceKey {
  family: SquadActivitySourceFamily
  groupId: string
}
export type Executor = Pick<typeof db, 'execute'>

/**
 * A uuid-typed join key derived from a text column, NULL when the text is not
 * a uuid.
 *
 * The natural-looking `agents.id::text = i.recipient_id` puts the cast on the
 * *indexed* side, which makes the condition unsargable: the planner cannot use
 * agents_pkey and falls back to a full sequential scan of `agents` for every
 * such join. loadInboxSnapshot had three of them, so a single-row lookup read
 * 1672 buffers and two 2506-row scans of `agents`. Casting the text side
 * instead keeps the primary key usable (15 buffers, all index scans).
 *
 * The regex guard is load-bearing, not defensive padding. These text columns
 * are varchar(200) and legitimately hold non-uuid values -- `recipient_id` is
 * the literal 'system' on recipient_type='system' rows -- so a bare `::uuid`
 * would raise "invalid input syntax for type uuid" and take the activity feed
 * down with it. Yielding NULL instead reproduces the old cast's behaviour
 * exactly: a non-uuid string matched no agent row under `id::text` either.
 *
 * Both interpolations are parenthesised because `::` binds tighter than
 * `->>`: unparenthesised, `i.metadata->>'workStreamId'::uuid` parses as
 * `i.metadata ->> ('workStreamId'::uuid)`, which casts the *key* and fails to
 * plan at all -- every call raises, not just the malformed rows.
 */
const uuidJoinKey = (expr: SQL) =>
  sql`(CASE WHEN (${expr}) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (${expr})::uuid END)`
const rows = <T>(result: Awaited<ReturnType<Executor['execute']>>) => result as unknown as T[]

interface GitHubActivityBase {
  sourceId: string
  activityId: string
  fact: GitHubPrDispatchFact
}

async function loadGitHubActivityBase(executor: Executor, sourceId: string): Promise<GitHubActivityBase | null> {
  const [prefix, activityId, extra] = sourceId.split(':')
  if (extra || !activityId || (prefix !== 'hook' && prefix !== 'poll')) return null
  if (prefix === 'hook') {
    const event = rows<any>(
      await executor.execute(sql`SELECT event_type,payload,headers->>'x-github-delivery' delivery_id FROM webhook_events
        WHERE id=${activityId}::uuid AND provider='github' AND verified=true`)
    )[0]
    if (!event) return null
    const fact = extractGitHubPrDispatchFact('github', {
      type: event.event_type,
      payload: event.payload,
      metadata: { source: 'webhook', providerDeliveryId: event.delivery_id },
    })
    return fact ? { sourceId, activityId, fact } : null
  }
  const dispatch = rows<any>(
    await executor.execute(sql`SELECT event_fact FROM integration_event_polling_dispatches
      WHERE provider_key='github' AND activity_id=${activityId}::uuid AND completed_at IS NOT NULL AND event_fact IS NOT NULL`)
  )[0]
  return dispatch && isGitHubPrDispatchFact(dispatch.event_fact)
    ? { sourceId, activityId, fact: dispatch.event_fact }
    : null
}

export interface GitHubAssociationPage {
  groupIds: string[]
  next: string | null
}

export async function listGitHubAssociationPage(
  sourceId: string,
  fact: GitHubPrDispatchFact,
  after: string | null,
  limit = 250
): Promise<GitHubAssociationPage> {
  const squads: any[] = rows<any>(
    await db.execute(sql`SELECT ws.squad_id FROM work_streams ws
      WHERE ${after ? sql`ws.squad_id>${after}::uuid` : sql`true`}
        AND (
          (ws.metadata->'codeHost'->>'integration'='github'
            AND lower(btrim(ws.metadata->'codeHost'->>'repository'))=${fact.repository}
            AND ws.metadata->'codeHost'->'changeRequest'->'number'=${JSON.stringify(fact.prNumber)}::jsonb)
          OR (NOT (ws.metadata ? 'codeHost')
            AND jsonb_typeof(ws.metadata->'github')='object'
            AND lower(btrim(ws.metadata->'github'->>'repo'))=${fact.repository}
            AND ws.metadata->'github'->'pr'->'number'=${JSON.stringify(fact.prNumber)}::jsonb)
        )
        ${
          sourceId.startsWith('hook:')
            ? sql`AND EXISTS (SELECT 1 FROM webhook_events we
              WHERE we.id=${sourceId.slice('hook:'.length)}::uuid AND we.verified=true
                AND ws.squad_id=ANY(we.activity_squad_ids))`
            : sql`AND EXISTS (SELECT 1 FROM integration_event_polling_dispatches pd
                WHERE pd.provider_key='github' AND pd.activity_id=${sourceId.slice('poll:'.length)}::uuid
                  AND ws.squad_id=ANY(pd.activity_squad_ids))`
        }
      GROUP BY ws.squad_id ORDER BY ws.squad_id LIMIT ${limit}`)
  )
  return {
    groupIds: squads.map((squad) => `${sourceId}:${squad.squad_id}`),
    next: squads.length === limit ? (squads.at(-1)?.squad_id ?? null) : null,
  }
}

export async function loadGitHubActivityBaseSource(sourceId: string): Promise<GitHubActivityBase | null> {
  return loadGitHubActivityBase(db, sourceId)
}

async function githubSquadOwnsSource(executor: Executor, sourceId: string, squadId: string): Promise<boolean> {
  if (sourceId.startsWith('hook:')) {
    const owned = rows<any>(
      await executor.execute(sql`SELECT 1 FROM webhook_events
      WHERE id=${sourceId.slice('hook:'.length)}::uuid AND verified=true
        AND ${squadId}::uuid=ANY(activity_squad_ids) LIMIT 1`)
    )
    return owned.length > 0
  }
  const activityId = sourceId.slice('poll:'.length)
  const owned = rows<any>(
    await executor.execute(sql`SELECT 1 FROM integration_event_polling_dispatches
      WHERE provider_key='github' AND activity_id=${activityId}::uuid
        AND ${squadId}::uuid=ANY(activity_squad_ids) LIMIT 1`)
  )
  return owned.length > 0
}

// ---------------------------------------------------------------------------
// Per-family snapshot loaders. Registered in families.ts; call them through
// `loadActivitySource` there rather than importing these directly.
// ---------------------------------------------------------------------------

export async function loadChatSnapshot(executor: Executor, groupId: string): Promise<ChatExecutionSnapshot | null> {
  const header = rows<any>(
    await executor.execute(
      sql`SELECT e.id,e.agent_id,a.squad_id,a.agent_type_id FROM executions e JOIN agents a ON a.id=e.agent_id WHERE e.id=${groupId}::uuid`
    )
  )[0]
  if (!header?.squad_id) return null
  const messages = rows<any>(
    await executor.execute(
      // Only assistant messages can become rows and only the first
      // substantive one is extracted; a small page covers leading
      // whitespace-only messages without shipping whole transcripts.
      sql`SELECT id,role,content,created_at FROM messages WHERE agent_id=${header.agent_id}::uuid AND metadata->>'executionId'=${groupId} AND role='assistant' ORDER BY created_at,id LIMIT 20`
    )
  )
  return {
    squadId: header.squad_id,
    executionId: header.id,
    agentId: header.agent_id,
    agentTypeId: header.agent_type_id,
    messages: messages.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    })),
  }
}

export async function loadExecutionSnapshot(executor: Executor, groupId: string): Promise<ExecutionSnapshot | null> {
  const row = rows<any>(
    await executor.execute(
      sql`SELECT e.*,a.squad_id,a.agent_type_id,a.parent_agent_id,
        a.metadata->>'name' agent_name,a.metadata->>'purpose' agent_purpose,
        parent.agent_type_id parent_type_id,parent.metadata->>'name' parent_name,parent.metadata->>'purpose' parent_purpose
        FROM executions e JOIN agents a ON a.id=e.agent_id
        LEFT JOIN agents parent ON parent.id=a.parent_agent_id
        WHERE e.id=${groupId}::uuid`
    )
  )[0]
  return row?.squad_id
    ? {
        squadId: row.squad_id,
        id: row.id,
        agentId: row.agent_id,
        agentTypeId: row.agent_type_id,
        status: row.status,
        runStartedAt: row.run_started_at,
        endedAt: row.ended_at,
        parentAgentId: row.parent_agent_id ?? null,
        parentAgentTypeId: row.parent_type_id ?? null,
        // Purpose first: for dispatched subagents it is the caller's label
        // (e.g. "plan-risk-review"), far more meaningful in the feed than the
        // auto-assigned codename (operator decision 2026-08-27).
        subagentName: row.agent_purpose ?? row.agent_name ?? null,
      }
    : null
}

export async function loadWorkStreamSnapshot(executor: Executor, groupId: string): Promise<WorkStreamSnapshot | null> {
  const row = rows<any>(
    await executor.execute(
      sql`SELECT ws.*,a.agent_type_id creator_type FROM work_streams ws LEFT JOIN agents a ON a.id=ws.creator_agent_id WHERE ws.id=${groupId}::uuid`
    )
  )[0]
  return row
    ? {
        squadId: row.squad_id,
        id: row.id,
        title: row.title,
        creatorAgentId: row.creator_agent_id,
        creatorAgentTypeId: row.creator_type,
        createdAt: row.created_at,
      }
    : null
}

export async function loadWaitSnapshot(executor: Executor, groupId: string): Promise<WaitSnapshot | null> {
  const row = rows<any>(
    await executor.execute(
      sql`SELECT w.*,ws.squad_id,a.agent_type_id creator_type FROM work_stream_waits w JOIN work_streams ws ON ws.id=w.work_stream_id LEFT JOIN agents a ON a.id=w.created_by_agent_id WHERE w.id=${groupId}::uuid`
    )
  )[0]
  return row
    ? {
        squadId: row.squad_id,
        id: row.id,
        workStreamId: row.work_stream_id,
        type: row.type,
        message: row.message,
        createdByAgentId: row.created_by_agent_id,
        createdByAgentTypeId: row.creator_type,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        resolution: row.resolution,
        resolutionNote: row.resolution_note,
      }
    : null
}

export async function loadInboxSnapshot(executor: Executor, groupId: string): Promise<InboxSnapshot | null> {
  const row = rows<any>(
    await executor.execute(
      sql`SELECT i.*,recipient.squad_id recipient_squad_id,recipient.agent_type_id recipient_type_id,
        recipient.metadata->>'name' recipient_name,recipient.metadata->>'purpose' recipient_purpose,
        sender.id sender_agent_id,sender.squad_id sender_squad_id,sender.status sender_status,
        sender.agent_type_id sender_type_id,sender.metadata->>'name' sender_name,sender.metadata->>'purpose' sender_purpose,
        sender_parent.agent_type_id sender_parent_type_id,
        ws.id ws_id,ws.squad_id ws_squad_id,ws.title ws_title,ws.owner_agent_id,s.manager_agent_id
        FROM inbox i LEFT JOIN agents recipient ON recipient.id=${uuidJoinKey(sql`i.recipient_id`)}
        LEFT JOIN agents sender ON i.sender_type='agent' AND sender.id=${uuidJoinKey(sql`i.sender_id`)}
        LEFT JOIN agents sender_parent ON sender_parent.id=sender.parent_agent_id
        LEFT JOIN work_streams ws ON ws.id=${uuidJoinKey(sql`i.metadata->>'workStreamId'`)}
        LEFT JOIN squads s ON s.id=ws.squad_id WHERE i.id=${groupId}::uuid`
    )
  )[0]
  return row
    ? {
        id: row.id,
        createdAt: row.created_at,
        recipientType: row.recipient_type,
        recipientId: row.recipient_id,
        recipientSquadId: row.recipient_squad_id,
        recipientAgentTypeId: row.recipient_type_id,
        recipientName: row.recipient_name ?? row.recipient_purpose ?? null,
        senderType: row.sender_type,
        senderId: row.sender_id,
        // The sender join no longer filters terminated agents (attribution
        // must survive a subagent's termination), so liveness is re-checked
        // here to keep the exact prior semantics of this flag.
        senderAgentExists:
          row.sender_agent_id !== null &&
          isLiveAgentStatus(row.sender_status as AgentStatus) &&
          row.sender_squad_id !== null &&
          row.sender_squad_id === row.recipient_squad_id,
        // Attribution only for same-squad senders — a cross-instance or
        // cross-squad sender's type/name is not this squad's to display.
        senderAgentTypeId: row.sender_squad_id === row.recipient_squad_id ? (row.sender_type_id ?? null) : null,
        // The SELECT has always carried sender_parent_type_id, but it was never
        // mapped — so the extractor's parent-type attribution for subagent
        // report rows silently fell back to the literal 'subagent' type.
        senderParentAgentTypeId:
          row.sender_squad_id === row.recipient_squad_id ? (row.sender_parent_type_id ?? null) : null,
        senderName:
          row.sender_squad_id === row.recipient_squad_id ? (row.sender_name ?? row.sender_purpose ?? null) : null,
        subject: row.subject ?? null,
        content: row.content,
        metadata: row.metadata,
        workStream: row.ws_id
          ? {
              id: row.ws_id,
              squadId: row.ws_squad_id,
              title: row.ws_title ?? '',
              ownerAgentId: row.owner_agent_id,
              managerAgentId: row.manager_agent_id,
            }
          : null,
      }
    : null
}

export async function loadGitHubPrSnapshot(executor: Executor, groupId: string): Promise<GitHubPrSnapshot | null> {
  const parts = groupId.split(':')
  const squadId = parts.pop()
  const sourceId = parts.join(':')
  if (!sourceId || !squadId) return null
  const base = await loadGitHubActivityBase(executor, sourceId)
  if (!base || !(await githubSquadOwnsSource(executor, sourceId, squadId))) return null
  let match: any = null
  let after: string | null = null
  do {
    const streams: any[] = rows<any>(
      await executor.execute(sql`SELECT id,metadata FROM work_streams WHERE squad_id=${squadId}::uuid
        ${after ? sql`AND id>${after}::uuid` : sql``} ORDER BY id LIMIT 250`)
    )
    match = streams.find((stream) => {
      const decoded = decodeGitHubPrWorkStreamMetadata(stream.metadata)
      return decoded?.repository === base.fact.repository && decoded.number === base.fact.prNumber
    })
    if (match || streams.length < 250) break
    after = streams.at(-1)?.id ?? null
  } while (after)
  return match
    ? {
        sourceId: base.sourceId,
        activityId: base.activityId,
        squadId,
        workStreamId: match.id,
        fact: base.fact,
      }
    : null
}

export interface SourceGroupCursor {
  /** Immutable source-row/facet identity; never a mutable transition timestamp. */
  id: string
  /** Present only while paging work-stream associations for one PR source. */
  associationAfter?: string
  sourceKind?: 'poll' | 'hook'
  receiptAt?: string
  scanId?: string
  pending?: Array<{ sourceId: string; fact: GitHubPrDispatchFact }>
  activeFact?: GitHubPrDispatchFact
  hasMoreCandidates?: boolean
}
export interface SourceGroupPage {
  groupIds: string[]
  next: SourceGroupCursor | null
}

// ---------------------------------------------------------------------------
// Per-family source-window pagers. Registered in families.ts; call them
// through `listSourceGroupPage` there rather than importing these directly.
// The five relational families share one shape: a facet CTE selecting
// (source_id, source_at, cursor_id) filtered to [from,to), keyset-paged on
// the immutable cursor_id.
// ---------------------------------------------------------------------------

function keysetPage(result: Awaited<ReturnType<Executor['execute']>>, limit: number): SourceGroupPage {
  const page = rows<any>(result)
  const last = page.at(-1)
  return {
    groupIds: page.map((row) => row.source_id).filter(Boolean),
    next: page.length === limit && last ? { id: last.cursor_id } : null,
  }
}

export async function listChatSourcePage(
  from: Date,
  to: Date,
  after: SourceGroupCursor | null,
  limit = 250
): Promise<SourceGroupPage> {
  return keysetPage(await db.execute(chatSourcePageSql(from, to, after, limit)), limit)
}

export function chatSourcePageSql(from: Date, to: Date, after: SourceGroupCursor | null, limit: number) {
  const keyset = after ? sql`AND cursor_id > ${after.id}` : sql``
  return sql`WITH source AS (
    SELECT activity_execution_id source_id,min(created_at) source_at,activity_execution_id cursor_id FROM messages
    WHERE created_at>=${from.toISOString()}::timestamptz AND created_at<${to.toISOString()}::timestamptz
      AND role='assistant' AND metadata ? 'executionId'
    GROUP BY activity_execution_id
  ) SELECT source_id,source_at,cursor_id FROM source WHERE true ${keyset} ORDER BY cursor_id LIMIT ${limit}`
}

export async function listExecutionSourcePage(
  from: Date,
  to: Date,
  after: SourceGroupCursor | null,
  limit = 250
): Promise<SourceGroupPage> {
  const keyset = after ? sql`AND cursor_id > ${after.id}` : sql``
  return keysetPage(
    await db.execute(sql`WITH facets AS (
      SELECT id::text source_id,run_started_at source_at,id::text||':0' cursor_id FROM executions WHERE run_started_at>=${from.toISOString()}::timestamptz AND run_started_at<${to.toISOString()}::timestamptz
      UNION ALL SELECT id::text,ended_at,id::text||':1' FROM executions WHERE ended_at>=${from.toISOString()}::timestamptz AND ended_at<${to.toISOString()}::timestamptz
    ) SELECT source_id,source_at,cursor_id FROM facets WHERE true ${keyset} ORDER BY cursor_id LIMIT ${limit}`),
    limit
  )
}

export async function listWorkStreamSourcePage(
  from: Date,
  to: Date,
  after: SourceGroupCursor | null,
  limit = 250
): Promise<SourceGroupPage> {
  const keyset = after ? sql`AND cursor_id > ${after.id}` : sql``
  return keysetPage(
    await db.execute(sql`WITH source AS (
      SELECT id::text source_id,created_at source_at,id::text cursor_id FROM work_streams WHERE created_at>=${from.toISOString()}::timestamptz AND created_at<${to.toISOString()}::timestamptz
    ) SELECT source_id,source_at,cursor_id FROM source WHERE true ${keyset} ORDER BY cursor_id LIMIT ${limit}`),
    limit
  )
}

export async function listWaitSourcePage(
  from: Date,
  to: Date,
  after: SourceGroupCursor | null,
  limit = 250
): Promise<SourceGroupPage> {
  const keyset = after ? sql`AND cursor_id > ${after.id}` : sql``
  return keysetPage(
    await db.execute(sql`WITH facets AS (
      SELECT id::text source_id,opened_at source_at,id::text||':0' cursor_id FROM work_stream_waits WHERE opened_at>=${from.toISOString()}::timestamptz AND opened_at<${to.toISOString()}::timestamptz
      UNION ALL SELECT id::text,closed_at,id::text||':1' FROM work_stream_waits WHERE closed_at>=${from.toISOString()}::timestamptz AND closed_at<${to.toISOString()}::timestamptz
    ) SELECT source_id,source_at,cursor_id FROM facets WHERE true ${keyset} ORDER BY cursor_id LIMIT ${limit}`),
    limit
  )
}

export async function listInboxSourcePage(
  from: Date,
  to: Date,
  after: SourceGroupCursor | null,
  limit = 250
): Promise<SourceGroupPage> {
  const keyset = after ? sql`AND cursor_id > ${after.id}` : sql``
  return keysetPage(
    await db.execute(sql`WITH source AS (
      SELECT id::text source_id,created_at source_at,id::text cursor_id FROM inbox WHERE created_at>=${from.toISOString()}::timestamptz AND created_at<${to.toISOString()}::timestamptz
    ) SELECT source_id,source_at,cursor_id FROM source WHERE true ${keyset} ORDER BY cursor_id LIMIT ${limit}`),
    limit
  )
}

export async function listGitHubPrSourcePage(
  from: Date,
  to: Date,
  after: SourceGroupCursor | null,
  limit = 250,
  scanTo: Date = to
): Promise<SourceGroupPage> {
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  const phase = after?.sourceKind ?? 'poll'
  let sourceId: string
  let fact: GitHubPrDispatchFact | null
  let cursor: SourceGroupCursor
  if (after?.associationAfter) {
    const base = after.activeFact ? null : await loadGitHubActivityBase(db, after.id)
    fact = after.activeFact ?? base?.fact ?? null
    if (!fact) return { groupIds: [], next: { ...after, associationAfter: undefined } }
    sourceId = after.id
    cursor = after
  } else if (phase === 'poll') {
    const activityAfter = after?.id.startsWith('poll:') ? after.id.slice('poll:'.length) : null
    const candidate = rows<any>(
      await db.execute(sql`SELECT activity_id::text id,event_fact FROM integration_event_polling_dispatches
        WHERE provider_key='github' AND completed_at IS NOT NULL AND activity_id IS NOT NULL AND event_fact IS NOT NULL
          AND event_occurred_at>=${fromIso}::timestamptz AND event_occurred_at<${toIso}::timestamptz
          ${activityAfter ? sql`AND activity_id::text>${activityAfter}` : sql``}
        ORDER BY activity_id LIMIT 1`)
    )[0]
    if (!candidate) return { groupIds: [], next: { id: '', sourceKind: 'hook', receiptAt: from.toISOString() } }
    sourceId = `poll:${candidate.id}`
    fact = isGitHubPrDispatchFact(candidate.event_fact) ? candidate.event_fact : null
    cursor = { id: sourceId, sourceKind: 'poll' }
  } else {
    let pending = after?.pending ?? []
    const receiptAfter = after?.receiptAt ?? from.toISOString()
    const eventAfter = after?.scanId ?? ''
    let hasMoreCandidates = after?.hasMoreCandidates ?? true
    if (pending.length === 0) {
      const candidates = rows<any>(
        await db.execute(sql`SELECT id::text id,event_type,payload,headers->>'x-github-delivery' delivery_id,created_at FROM webhook_events
          WHERE provider='github' AND verified=true
            AND created_at>=${fromIso}::timestamptz AND created_at<${scanTo.toISOString()}::timestamptz
            AND (created_at>${receiptAfter}::timestamptz OR (created_at=${receiptAfter}::timestamptz AND id::text>${eventAfter}))
          ORDER BY created_at,id LIMIT ${limit}`)
      )
      if (candidates.length === 0) return { groupIds: [], next: null }
      pending = candidates.flatMap((candidate) => {
        const extracted = extractGitHubPrDispatchFact('github', {
          type: candidate.event_type,
          payload: candidate.payload,
          metadata: { source: 'webhook', providerDeliveryId: candidate.delivery_id },
        })
        const occurred = extracted ? new Date(extracted.occurredAt) : null
        return extracted && occurred && occurred >= from && occurred < to
          ? [{ sourceId: `hook:${candidate.id}`, fact: extracted }]
          : []
      })
      const last = candidates.at(-1)
      hasMoreCandidates = candidates.length === limit
      const scanCursor: SourceGroupCursor = {
        id: '',
        sourceKind: 'hook',
        receiptAt: new Date(last.created_at).toISOString(),
        scanId: last.id,
        pending,
        hasMoreCandidates,
      }
      if (pending.length === 0) return { groupIds: [], next: hasMoreCandidates ? scanCursor : null }
      after = scanCursor
    }
    const [current, ...remaining] = pending
    sourceId = current.sourceId
    fact = current.fact
    cursor = {
      id: sourceId,
      sourceKind: 'hook',
      receiptAt: after?.receiptAt,
      scanId: after?.scanId,
      pending: remaining,
      activeFact: fact,
      hasMoreCandidates,
    }
  }
  if (!fact) return { groupIds: [], next: cursor }
  const associations = await listGitHubAssociationPage(sourceId, fact, after?.associationAfter ?? null, limit)
  return {
    groupIds: associations.groupIds,
    next: associations.next
      ? { ...cursor, associationAfter: associations.next }
      : cursor.sourceKind === 'hook'
        ? cursor.pending?.length || cursor.hasMoreCandidates
          ? {
              id: '',
              sourceKind: 'hook',
              receiptAt: cursor.receiptAt,
              scanId: cursor.scanId,
              pending: cursor.pending,
              hasMoreCandidates: cursor.hasMoreCandidates,
            }
          : null
        : { id: cursor.id, sourceKind: cursor.sourceKind },
  }
}

export async function listProjectedSourceGroupPage(
  family: SquadActivitySourceFamily,
  from: Date,
  to: Date,
  after: string | null,
  limit = 250
): Promise<{ groupIds: string[]; next: string | null }> {
  const result = rows<any>(
    await db.execute(sql`SELECT source_group_id
    FROM squad_activity WHERE source_family=${family}
      AND at>=${from.toISOString()}::timestamptz AND at<${to.toISOString()}::timestamptz
      ${after ? sql`AND source_group_id>${after}` : sql``}
    GROUP BY source_group_id ORDER BY source_group_id LIMIT ${limit}`)
  )
  const groupIds = result.map((row) => row.source_group_id as string)
  return { groupIds, next: groupIds.length === limit ? groupIds.at(-1)! : null }
}
