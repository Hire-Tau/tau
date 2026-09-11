-- Backfill metadata.executionId onto historical assistant rows.
--
-- Assistant messages carried the execution identity only as the prefix of
-- streamGroupId (`<executionId>:<runId>:<counter>`); the recovery layer's
-- completion inference queries `metadata->>'executionId'` and so never matched
-- an assistant row, causing finished dead-owner executions to be requeued and
-- re-run. Persistence now stamps `executionId` as a first-class field; this
-- backfills the same value onto existing rows so already-stuck executions heal
-- on their next recovery pass without a redundant re-run.
--
-- executionId is a UUID, so it never contains ':'; split_part(...,':',1) is the
-- exact prefix. Scoped to assistant rows that have a streamGroupId but no
-- executionId yet, so it is idempotent and touches nothing already stamped.
UPDATE messages
SET metadata = jsonb_set(
  metadata,
  '{executionId}',
  to_jsonb(split_part(metadata->>'streamGroupId', ':', 1))
)
WHERE role = 'assistant'
  AND metadata->>'streamGroupId' IS NOT NULL
  AND metadata->>'executionId' IS NULL
  AND split_part(metadata->>'streamGroupId', ':', 1) <> '';
