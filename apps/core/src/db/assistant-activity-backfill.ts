import type postgres from 'postgres'

/**
 * Frozen upgrade transform: project historical saved-Assistant inbox traffic into
 * assistant_tasks / assistant_updates. Runs inside the migration transaction right after the new
 * tables and their constraints exist. Idempotent: every insert targets the new primary/unique
 * keys with ON CONFLICT DO NOTHING and every update is guarded by "not already set".
 *
 * Historical rows carry no structured lifecycle, so every reconstructed task is `unknown`. The
 * old `inbox.read_at` cannot distinguish machine consumption from human viewing, so it becomes
 * both `processed_at` and `seen_at`; previously unread messages stay unread. Nothing here emits
 * events, wakes agents, or touches the runtime entities.
 */
const ASSISTANT_MAILBOX = String.raw`'^assistant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`

const CHAIN_CTE = `
WITH RECURSIVE requests AS (
  SELECT i.id, c.id AS conversation_id, i.recipient_id, i.metadata, i.content, i.created_at
  FROM inbox i
  JOIN assistant_conversations c ON c.id::text = substring(i.sender_id from 11)
  WHERE i.sender_type = 'voice_assistant' AND i.recipient_type = 'agent' AND i.sender_id ~* ${ASSISTANT_MAILBOX}
),
updates AS (
  SELECT i.id, c.id AS conversation_id, i.sender_id, i.metadata, i.read_at, i.created_at
  FROM inbox i
  JOIN assistant_conversations c ON c.id::text = substring(i.recipient_id from 11)
  WHERE i.recipient_type = 'voice_assistant' AND i.recipient_id ~* ${ASSISTANT_MAILBOX}
),
chain AS (
  -- Roots: requests whose inReplyTo does not resolve to an update of the same conversation.
  SELECT r.id, r.id AS task_id, r.conversation_id, r.created_at, 0 AS depth
  FROM requests r
  WHERE NOT EXISTS (
    SELECT 1 FROM updates u WHERE u.id::text = r.metadata->>'inReplyTo' AND u.conversation_id = r.conversation_id
  )
  UNION ALL
  -- Follow-ups: a request answering an update that answered a request already in the chain.
  SELECT r.id, ch.task_id, r.conversation_id, r.created_at, ch.depth + 1
  FROM requests r
  JOIN updates u ON u.id::text = r.metadata->>'inReplyTo' AND u.conversation_id = r.conversation_id
  JOIN chain ch ON ch.id::text = u.metadata->>'inReplyTo' AND ch.conversation_id = u.conversation_id
  WHERE ch.depth < 10000
)`

export async function backfillAssistantActivity(connection: postgres.ReservedSql): Promise<void> {
  // 1. One task per root request; the newest request in the chain is current. Distinct roots stay
  //    distinct even when they reused the same helper agent.
  await connection.unsafe(`${CHAIN_CTE}
    INSERT INTO assistant_tasks
      (id, conversation_id, current_request_id, agent_id, kind, squad_id, label, status, created_at, updated_at)
    SELECT DISTINCT ON (ch.task_id)
      ch.task_id, ch.conversation_id, ch.id,
      a.id,
      CASE
        WHEN owned.agent_id IS NOT NULL AND owned.squad_id IS NOT NULL THEN 'squad'
        WHEN owned.agent_id IS NOT NULL THEN 'background'
        ELSE 'agent'
      END,
      CASE WHEN owned.agent_id IS NOT NULL AND owned.squad_id IS NOT NULL THEN owned.squad_id END,
      CASE
        WHEN length(trim(split_part(root.content, E'\\n', 1))) > 80
          THEN left(trim(split_part(root.content, E'\\n', 1)), 79) || '…'
        WHEN length(trim(split_part(root.content, E'\\n', 1))) = 0 THEN 'Assistant task'
        ELSE trim(split_part(root.content, E'\\n', 1))
      END,
      'unknown', root.created_at, ch.created_at
    FROM chain ch
    JOIN requests root ON root.id = ch.task_id
    JOIN requests current ON current.id = ch.id
    LEFT JOIN agents a ON a.id::text = current.recipient_id
    LEFT JOIN assistant_conversation_agents owned
      ON owned.conversation_id = ch.conversation_id AND owned.agent_id = a.id
    ORDER BY ch.task_id, ch.created_at DESC, ch.id DESC
    ON CONFLICT (id) DO NOTHING`)

  // 2. Every request in a chain records its task so post-upgrade replies correlate exactly like
  //    new requests do.
  await connection.unsafe(`${CHAIN_CTE}
    UPDATE inbox SET metadata = inbox.metadata || jsonb_build_object('assistantTaskId', ch.task_id::text)
    FROM chain ch
    WHERE inbox.id = ch.id AND NOT (inbox.metadata ? 'assistantTaskId')`)

  // 3. Incoming messages become updates in stable (created_at, id) order. Sequences continue
  //    after any already allocated so a partial earlier run cannot collide.
  await connection.unsafe(`
    INSERT INTO assistant_updates
      (message_id, conversation_id, task_id, request_id, sequence, reported_status, processed_at, seen_at, created_at)
    SELECT u.id, u.conversation_id, t.id, req.id,
      coalesce(allocated.max_sequence, 0) + row_number() OVER (PARTITION BY u.conversation_id ORDER BY u.created_at, u.id),
      CASE WHEN u.metadata->>'assistantTaskStatus' IN ('working', 'waiting', 'needs-input', 'completed', 'failed', 'cancelled')
        THEN u.metadata->>'assistantTaskStatus' END,
      u.read_at, u.read_at, u.created_at
    FROM (
      SELECT i.id, c.id AS conversation_id, i.metadata, i.read_at, i.created_at
      FROM inbox i
      JOIN assistant_conversations c ON c.id::text = substring(i.recipient_id from 11)
      WHERE i.recipient_type = 'voice_assistant' AND i.recipient_id ~* ${ASSISTANT_MAILBOX}
        AND NOT EXISTS (SELECT 1 FROM assistant_updates existing WHERE existing.message_id = i.id)
    ) u
    LEFT JOIN inbox req ON req.id::text = u.metadata->>'inReplyTo'
      AND req.sender_type = 'voice_assistant' AND req.recipient_type = 'agent'
      AND req.sender_id = 'assistant:' || u.conversation_id::text
    LEFT JOIN assistant_tasks t ON t.id::text = req.metadata->>'assistantTaskId' AND t.conversation_id = u.conversation_id
    LEFT JOIN (
      SELECT conversation_id, max(sequence) AS max_sequence FROM assistant_updates GROUP BY conversation_id
    ) allocated ON allocated.conversation_id = u.conversation_id
    ON CONFLICT DO NOTHING`)

  // 4. The allocator must never hand out a sequence an imported update already holds.
  await connection.unsafe(`
    UPDATE assistant_conversations c SET next_update_sequence = m.max_sequence
    FROM (SELECT conversation_id, max(sequence) AS max_sequence FROM assistant_updates GROUP BY conversation_id) m
    WHERE m.conversation_id = c.id AND c.next_update_sequence < m.max_sequence`)
}
