import { createHash } from 'node:crypto'
import type { VerifiedIngressEvent } from '../integrations/types'

export interface LinearIssueDispatchFact {
  eventType: 'Issue' | 'Comment'
  action: 'assigned' | 'unassigned' | 'state' | 'title' | 'labels' | 'updated' | 'comment' | 'comment-edited'
  occurredAt: string
  actorId: string | null
  /** Display only: the actor's name when Linear named one. Never part of the row identity. */
  actorName: string | null
  /** Linear's own issue id — the only identity a comment delivery always carries. */
  issueId: string
  identifier: string | null
  /** Lowercase team key (`eng`), matching how tracked resources store it. */
  teamKey: string | null
  number: number | null
  title: string
  stateType: string | null
  /** The dedupe-significant subject: new state name, assignee id, joined label names; null otherwise. */
  detail: string | null
  nativeId: string
  providerDeliveryId: string | null
  logicalRowId: string
  url: string | null
}

type IssueAction = LinearIssueDispatchFact['action']

const ACTIONS: Record<LinearIssueDispatchFact['eventType'], ReadonlySet<IssueAction>> = {
  Issue: new Set<IssueAction>(['assigned', 'unassigned', 'state', 'title', 'labels', 'updated']),
  Comment: new Set<IssueAction>(['comment', 'comment-edited']),
}
/** A Linear team key is a short alphanumeric code such as `ENG`, never an `owner/repo` path. */
const TEAM_KEY = /^[a-z][a-z0-9]{0,9}$/
const HTTPS_URL = /^https:\/\/\S+$/
// Display-only fields are bounded here so a hostile title or label cannot overflow the
// 512-char summary column (or the row payload) downstream. Identity fields are never truncated.
const TITLE_LIMIT = 200
// Wider than GitHub's single-subject detail: a label change names every label on the issue.
const DETAIL_LIMIT = 200
const ID_LIMIT = 200

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const string = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const positiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
const timestamp = (value: unknown): string | null => {
  const raw = string(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString()
}
/** Bound by code point, never by UTF-16 unit — a split surrogate pair is not storable text. */
const bounded = (value: string, limit: number): string => [...value].slice(0, limit).join('')
const identity = (value: unknown): string | null => {
  const raw = string(value)
  return raw && [...raw].length <= ID_LIMIT ? raw : null
}
const url = (value: unknown): string | null => {
  const raw = string(value)
  return raw && HTTPS_URL.test(raw) && raw.length <= 2000 ? raw : null
}

export function linearIssueLogicalRowId(
  fact: Pick<LinearIssueDispatchFact, 'eventType' | 'action' | 'occurredAt' | 'issueId' | 'nativeId' | 'detail'>
): string {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        'linear-issue',
        fact.issueId,
        fact.eventType,
        fact.action,
        fact.detail ?? '',
        fact.nativeId,
        fact.occurredAt,
      ])
    )
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function isLinearIssueDispatchFact(value: unknown): value is LinearIssueDispatchFact {
  const fact = object(value)
  const eventType = fact?.eventType as LinearIssueDispatchFact['eventType'] | undefined
  const action = fact?.action as IssueAction | undefined
  return Boolean(
    fact &&
    eventType &&
    Object.hasOwn(ACTIONS, eventType) &&
    typeof action === 'string' &&
    ACTIONS[eventType].has(action) &&
    timestamp(fact.occurredAt) === fact.occurredAt &&
    (fact.actorId === null || identity(fact.actorId) === fact.actorId) &&
    // Display-only, so a stored name is accepted as it stands: it identifies nothing.
    (fact.actorName === null || (typeof fact.actorName === 'string' && [...fact.actorName].length <= TITLE_LIMIT)) &&
    identity(fact.issueId) === fact.issueId &&
    (fact.identifier === null || (typeof fact.identifier === 'string' && [...fact.identifier].length <= 100)) &&
    (fact.teamKey === null || (typeof fact.teamKey === 'string' && TEAM_KEY.test(fact.teamKey))) &&
    (fact.number === null || positiveInteger(fact.number) !== null) &&
    typeof fact.title === 'string' &&
    [...fact.title].length <= TITLE_LIMIT &&
    (fact.stateType === null || (typeof fact.stateType === 'string' && [...fact.stateType].length <= 100)) &&
    (fact.detail === null || (typeof fact.detail === 'string' && [...fact.detail].length <= DETAIL_LIMIT)) &&
    identity(fact.nativeId) === fact.nativeId &&
    (fact.providerDeliveryId === null || Boolean(string(fact.providerDeliveryId))) &&
    (fact.url === null || url(fact.url) === fact.url) &&
    typeof fact.logicalRowId === 'string' &&
    fact.logicalRowId ===
      linearIssueLogicalRowId({
        eventType,
        action,
        occurredAt: String(fact.occurredAt),
        issueId: String(fact.issueId),
        nativeId: String(fact.nativeId),
        detail: fact.detail === null ? null : String(fact.detail),
      })
  )
}

/**
 * Normalize a verified Linear `Issue` / `Comment` delivery into the authoritative
 * fact the Activity projection stores.
 *
 * Linear reports every issue change as one `update` action and names what moved in
 * `updatedFrom`; that map — never the mutable payload alone — decides which fact this
 * delivery is, so one precedence order yields exactly one action per delivery. A
 * delivery whose body disagrees with its `Linear-Event` header, or that names no
 * issue, yields no fact at all rather than a row attributed to the wrong resource.
 */
export function extractLinearIssueDispatchFact(
  providerKey: string,
  event: VerifiedIngressEvent
): LinearIssueDispatchFact | null {
  if (providerKey !== 'linear' || !Object.hasOwn(ACTIONS, event.type)) return null
  const eventType = event.type as LinearIssueDispatchFact['eventType']
  const payload = object(event.payload)
  const data = object(payload?.data)
  const rawAction = string(payload?.action)
  if (!payload || !data || !rawAction) return null
  // The signature covers the body only, so a replay with a mutated `Linear-Event` header
  // cannot re-type the delivery.
  if (string(payload.type) && payload.type !== eventType) return null

  const comment = eventType === 'Comment'
  // Issue details live on the payload for issue events, and on the nested issue for comments.
  const source = comment ? (object(data.issue) ?? {}) : data
  const issueId = comment ? (identity(data.issueId) ?? identity(source.id)) : identity(data.id)
  if (!issueId) return null
  const nativeId = comment ? identity(data.id) : issueId
  if (!nativeId) return null

  const updatedFrom = object(payload.updatedFrom) ?? {}
  const assigneeId = identity(data.assigneeId)
  let action: IssueAction
  if (comment) {
    if (rawAction !== 'create' && rawAction !== 'update') return null
    action = rawAction === 'create' ? 'comment' : 'comment-edited'
  } else {
    // Creation and removal are not Activity facts: a tracked issue is only ever
    // followed after it exists, and a removal has no resource left to point at.
    if (rawAction !== 'update') return null
    action = Object.hasOwn(updatedFrom, 'assigneeId')
      ? assigneeId
        ? 'assigned'
        : 'unassigned'
      : Object.hasOwn(updatedFrom, 'stateId')
        ? 'state'
        : Object.hasOwn(updatedFrom, 'title')
          ? 'title'
          : Object.hasOwn(updatedFrom, 'labelIds')
            ? 'labels'
            : 'updated'
  }

  const stamp =
    typeof payload.webhookTimestamp === 'number' && Math.abs(payload.webhookTimestamp) < 8.64e15
      ? new Date(payload.webhookTimestamp).toISOString()
      : null
  // An edit is timed by the edit, so a later revision is its own fact rather than a duplicate.
  const occurredAt =
    (comment ? timestamp(action === 'comment' ? data.createdAt : data.updatedAt) : timestamp(data.updatedAt)) ?? stamp
  if (!occurredAt) return null

  let detail: string | null = null
  if (action === 'assigned') detail = assigneeId
  else if (action === 'unassigned') detail = identity(updatedFrom.assigneeId)
  else if (action === 'state') detail = string(object(data.state)?.name)
  else if (action === 'labels')
    detail =
      (Array.isArray(source.labels)
        ? source.labels
            .slice(0, 100)
            .map((label: unknown) => string(object(label)?.name))
            .filter(Boolean)
            .join(', ')
        : '') || null
  if (detail) detail = bounded(detail, DETAIL_LIMIT)

  // Linear names the actor on the payload; a comment delivery names its author instead.
  const actorName = string(object(payload.actor)?.name) ?? string(object(data.user)?.name)
  const teamKey = string(object(source.team)?.key)?.toLowerCase() ?? null
  const identifierValue = string(source.identifier)
  const providerDeliveryId =
    event.metadata && typeof event.metadata.providerDeliveryId === 'string' && event.metadata.providerDeliveryId.trim()
      ? event.metadata.providerDeliveryId.trim()
      : null
  return {
    eventType,
    action,
    occurredAt,
    // Who acted on this delivery (the editor of an edited comment), not necessarily its author.
    actorId: identity(object(payload.actor)?.id) ?? identity(data.userId),
    actorName: actorName ? bounded(actorName, TITLE_LIMIT) : null,
    issueId,
    identifier: identifierValue ? bounded(identifierValue, 100) : null,
    teamKey: teamKey && TEAM_KEY.test(teamKey) ? teamKey : null,
    number: positiveInteger(source.number),
    title: bounded(string(source.title) ?? '', TITLE_LIMIT),
    stateType: string(object(source.state)?.type)?.slice(0, 100) ?? null,
    detail,
    nativeId,
    providerDeliveryId,
    logicalRowId: linearIssueLogicalRowId({ eventType, action, occurredAt, issueId, nativeId, detail }),
    url: url(data.url),
  }
}

/** Past-tense phrase for the fact, in the feed's voice. */
export function describeLinearIssueFact(fact: Pick<LinearIssueDispatchFact, 'action' | 'detail'>): string {
  switch (fact.action) {
    case 'state':
      return fact.detail ? `moved to ${fact.detail}` : 'moved'
    case 'title':
      return 'title edited'
    case 'labels':
      return 'labels changed'
    case 'comment-edited':
      return 'comment edited'
    default:
      return fact.action // assigned | unassigned | updated | comment
  }
}
