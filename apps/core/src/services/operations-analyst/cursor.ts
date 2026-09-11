import { createHash } from 'node:crypto'
import type { PermissionSquadScope } from '../rbac/permission-scope'

export class InvalidRecommendationCursorError extends Error {}
export class RecommendationCursorResetRequiredError extends Error {}

export interface RecommendationCursorContext {
  status?: string | null
  squadId?: string | null
  identitySubject: string
  squadScope: PermissionSquadScope
}

interface CursorPayload {
  v: 1
  queryDigest: string
  authorizationDigest: string
  lastSeenAt: string
  id: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const queryDigest = (context: RecommendationCursorContext) =>
  digest({ v: 1, status: context.status ?? null, squadId: context.squadId ?? null })
const authorizationDigest = (context: RecommendationCursorContext) =>
  digest({ subject: context.identitySubject, scope: context.squadScope })

export function encodeRecommendationCursor(
  keyset: { lastSeenAt: Date; id: string },
  context: RecommendationCursorContext
): string {
  const payload: CursorPayload = {
    v: 1,
    queryDigest: queryDigest(context),
    authorizationDigest: authorizationDigest(context),
    lastSeenAt: keyset.lastSeenAt.toISOString(),
    id: keyset.id,
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function decodeRecommendationCursor(
  encoded: string,
  context: RecommendationCursorContext
): { lastSeenAt: Date; id: string } {
  if (!encoded || encoded.length > 1000) throw new InvalidRecommendationCursorError('invalid-cursor')
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
  } catch {
    throw new InvalidRecommendationCursorError('invalid-cursor')
  }
  if (!payload || typeof payload !== 'object') throw new InvalidRecommendationCursorError('invalid-cursor')
  const cursor = payload as Partial<CursorPayload>
  if (
    cursor.v !== 1 ||
    typeof cursor.queryDigest !== 'string' ||
    cursor.queryDigest.length !== 64 ||
    typeof cursor.authorizationDigest !== 'string' ||
    cursor.authorizationDigest.length !== 64 ||
    typeof cursor.lastSeenAt !== 'string' ||
    cursor.lastSeenAt.length > 40 ||
    typeof cursor.id !== 'string' ||
    !UUID.test(cursor.id)
  ) {
    throw new InvalidRecommendationCursorError('invalid-cursor')
  }
  const at = new Date(cursor.lastSeenAt)
  if (Number.isNaN(at.valueOf()) || at.toISOString() !== cursor.lastSeenAt) {
    throw new InvalidRecommendationCursorError('invalid-cursor')
  }
  if (cursor.queryDigest !== queryDigest(context)) throw new InvalidRecommendationCursorError('invalid-cursor')
  if (cursor.authorizationDigest !== authorizationDigest(context)) {
    throw new RecommendationCursorResetRequiredError('authorization-changed')
  }
  return { lastSeenAt: at, id: cursor.id }
}
