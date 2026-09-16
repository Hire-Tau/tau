import { createHash } from 'node:crypto'

/**
 * Row identity for one event attributed to one work stream.
 *
 * A single GitHub event can belong to several of a squad's work streams, and
 * each gets its own `squad_activity` row. The FIRST stream keeps the fact's own
 * `logicalRowId` so rows written before multi-stream attribution stay exactly
 * where they are (these families are append-only: a changed id would orphan the
 * old row rather than replace it). Every further stream derives a stable id from
 * the pair, shaped like `githubPrLogicalRowId`/`githubIssueLogicalRowId` so it
 * is storable in the uuid column.
 *
 * The cost of that stability is that the mapping is positional: if the oldest
 * tracking stream is deleted or stops tracking the resource, the next stream
 * becomes first, and a later repair inserts a second row keyed by `logicalRowId`
 * for it while its derived row survives (these families never delete), so that
 * stream shows the event twice. Accepted, to keep already-written rows stable.
 */
export function activityRowIdForStream(logicalRowId: string, workStreamId: string, index: number): string {
  if (index === 0) return logicalRowId
  const hex = createHash('sha256').update(`${logicalRowId}:${workStreamId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
