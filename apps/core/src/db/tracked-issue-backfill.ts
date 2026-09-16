import type postgres from 'postgres'

/** The row's existing links, or an empty list when `tracked` is absent or not an array. */
const TRACKED = `COALESCE(CASE WHEN jsonb_typeof(metadata->'tracked') = 'array' THEN metadata->'tracked' END, '[]'::jsonb)`
/** Bounded so the cast below can never overflow and the result stays a safe integer. */
const LEGACY_ISSUE = `(metadata->'github'->>'issue') ~ '^[1-9][0-9]{0,14}$'`

const STATEMENT = `
  UPDATE work_streams SET metadata = jsonb_set(
    metadata - 'github' || jsonb_build_object('github', (metadata->'github') - 'issue'),
    '{tracked}',
    ${TRACKED} || CASE
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(${TRACKED}) AS entry
        WHERE entry->>'integration' = 'github'
          AND entry->>'kind' = 'issue'
          AND lower(btrim(entry->>'repository')) = lower(btrim(metadata->'github'->>'repo'))
          AND entry->'number' = to_jsonb((metadata->'github'->>'issue')::bigint)
      ) THEN '[]'::jsonb
      ELSE jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'integration', 'github',
        'repository', lower(btrim(metadata->'github'->>'repo')),
        'kind', 'issue',
        'number', (metadata->'github'->>'issue')::bigint,
        'connectionId', metadata->'github'->>'connectionId',
        'addedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )))
    END)
  WHERE jsonb_typeof(metadata->'github') = 'object'
    AND metadata->'github'->>'repo' IS NOT NULL
    AND ${LEGACY_ISSUE}
`

/**
 * Moves the legacy `metadata.github.issue` pointer into a `metadata.tracked` entry, which is the
 * only place a work stream records the issues it follows. Idempotent: the statement is gated on
 * rows that still carry the pointer, so a converted row is never rewritten, and an entry that
 * already covers the same issue is kept instead of duplicated.
 */
export async function backfillTrackedIssues(connection: postgres.ReservedSql): Promise<{ updated: number }> {
  const result = await connection.unsafe(STATEMENT)
  return { updated: result.count }
}
