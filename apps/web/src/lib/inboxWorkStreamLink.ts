/**
 * Extracts a navigation path to the work stream detail for an inbox message,
 * when the message carries work-stream status metadata. Returns null otherwise.
 *
 * Work-stream status messages set `metadata.workStreamId` and `metadata.squadId`
 * (see apps/core/src/services/squad/work-stream-notifications.ts).
 */
export function getWorkStreamLink(metadata: Record<string, unknown>): string | null {
  const actionId = metadata.actionId
  if (typeof actionId === 'string' && actionId.trim()) return `/actions/${encodeURIComponent(actionId)}`

  const workStreamId = metadata.workStreamId
  const squadId = metadata.squadId

  if (typeof workStreamId !== 'string' || !workStreamId) return null
  if (typeof squadId !== 'string' || !squadId) return null

  return `/squads/${squadId}/work?ws=${workStreamId}`
}
