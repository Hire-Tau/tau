ALTER TABLE "agents" ADD COLUMN "last_message_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_human_message_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_message_preview" text;--> statement-breakpoint
-- Backfill. Without this every pre-existing agent reads null until its next
-- message, which would silently empty the conversation list's ordering and
-- previews rather than fail visibly.
--
-- One pass over messages grouped by agent, NOT the per-agent correlated
-- subqueries this migration exists to delete. The expression mirrors
-- entities/message-time.ts's messageSortAtSql exactly; if that changes, this
-- is dead weight but not wrong — refreshAgentActivity() rewrites each row on
-- its next message either way.
WITH ranked AS (
  SELECT
    m."agent_id",
    date_trunc(
      'milliseconds',
      CASE
        WHEN m."role" = 'human' AND (m."metadata"->>'consumedAt') IS NOT NULL
          THEN (m."metadata"->>'consumedAt')::timestamptz
        ELSE m."created_at" AT TIME ZONE 'UTC'
      END
    ) AT TIME ZONE 'UTC' AS sort_at,
    m."role",
    m."content",
    ROW_NUMBER() OVER (
      PARTITION BY m."agent_id"
      ORDER BY date_trunc(
        'milliseconds',
        CASE
          WHEN m."role" = 'human' AND (m."metadata"->>'consumedAt') IS NOT NULL
            THEN (m."metadata"->>'consumedAt')::timestamptz
          ELSE m."created_at" AT TIME ZONE 'UTC'
        END
      ) AT TIME ZONE 'UTC' DESC, m."id" DESC
    ) AS rn
  FROM "messages" m
  WHERE m."pending" = false
),
summary AS (
  SELECT
    "agent_id",
    MAX(sort_at) AS last_message_at,
    MAX(sort_at) FILTER (WHERE "role" = 'human') AS last_human_message_at,
    MAX(LEFT("content", 280)) FILTER (WHERE rn = 1) AS last_message_preview
  FROM ranked
  GROUP BY "agent_id"
)
UPDATE "agents" a
SET "last_message_at" = s.last_message_at,
    "last_human_message_at" = s.last_human_message_at,
    "last_message_preview" = s.last_message_preview
FROM summary s
WHERE a."id" = s."agent_id";
