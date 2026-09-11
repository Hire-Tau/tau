-- Backfill invalid terminal completion metadata from the row's pre-migration update timestamp.
-- Valid timestamp strings are deliberately preserved byte-for-byte.
WITH invalid_terminal AS (
  SELECT
    id,
    jsonb_set(
      jsonb_set(
        CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
        '{completion}',
        CASE
          WHEN jsonb_typeof(metadata->'completion') = 'object' THEN metadata->'completion'
          ELSE '{}'::jsonb
        END,
        true
      ),
      '{completion,completedAt}',
      to_jsonb(to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      true
    ) AS repaired_metadata
  FROM work_streams
  WHERE status IN ('done', 'canceled')
    AND NOT CASE
      WHEN jsonb_typeof(metadata->'completion'->'completedAt') = 'string'
        AND pg_input_is_valid(metadata->'completion'->>'completedAt', 'timestamp with time zone')
      THEN isfinite((metadata->'completion'->>'completedAt')::timestamptz)
      ELSE false
    END
)
UPDATE work_streams AS work_stream
SET metadata = invalid_terminal.repaired_metadata
FROM invalid_terminal
WHERE work_stream.id = invalid_terminal.id;
