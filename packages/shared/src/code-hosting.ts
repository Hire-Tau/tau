import { z } from 'zod'

/** Resource identity only. Access always comes from the integration's squad connection. */
export const codeHostReferenceSchema = z
  .object({
    integration: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(100),
    repository: z.string().trim().min(1).max(500),
    changeRequest: z
      .object({ number: z.number().int().positive().safe(), url: z.string().url().optional() })
      .strict()
      .optional(),
    connectionId: z.string().uuid().optional(),
  })
  .strict()
export type CodeHostReference = z.infer<typeof codeHostReferenceSchema>

/** An explicit canonical binding takes precedence, including when it is invalid. */
export function resolveCodeHostReference(metadata: unknown): CodeHostReference | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const record = metadata as Record<string, any>
  const value =
    record.codeHost !== undefined
      ? record.codeHost
      : record.github
        ? {
            integration: 'github',
            repository: record.github.repo,
            changeRequest:
              record.github.pr?.number != null
                ? {
                    number: Number(record.github.pr.number),
                    ...(record.github.pr.url ? { url: record.github.pr.url } : {}),
                  }
                : undefined,
            connectionId: record.github.connectionId,
          }
        : undefined
  const result = codeHostReferenceSchema.safeParse(value)
  return result.success ? result.data : null
}

export const TRACKED_RESOURCE_KINDS = ['issue', 'pull_request'] as const
export type TrackedResourceKind = (typeof TRACKED_RESOURCE_KINDS)[number]
const integrationName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(100)
export const trackedResourceOriginSchema = z
  .object({
    eventId: z.string().uuid(),
    resourceKey: z.string().min(1).max(500),
    output: z.string().min(1).max(100),
    occurredAt: z.string().max(64).optional(),
  })
  .strict()
/** Tracked resource identity. Access always comes from the squad's integration connection, never from this record. */
export const trackedResourceObjectSchema = z
  .object({
    integration: integrationName,
    repository: z.string().trim().min(1).max(500),
    kind: z.enum(TRACKED_RESOURCE_KINDS),
    number: z.number().int().positive().safe(),
    connectionId: z.string().uuid().optional(),
    // Only web links: a `javascript:`/`data:` value would otherwise render as a clickable link.
    url: z
      .string()
      .url()
      .regex(/^https?:\/\//i)
      .max(2000)
      .optional(),
    addedAt: z.string().max(64).optional(),
    origin: trackedResourceOriginSchema.optional(),
    // Only meaningful for kind 'pull_request'; flags a tracked PR as a delivery change request.
    delivery: z.literal(true).optional(),
  })
  .strict()
/** Same identity as {@link trackedResourceObjectSchema}, plus the cross-field delivery/kind constraint. */
export const trackedResourceSchema = trackedResourceObjectSchema.refine(
  (value) => !value.delivery || value.kind === 'pull_request',
  { message: 'delivery is only valid for pull requests', path: ['delivery'] }
)
export type TrackedResource = z.infer<typeof trackedResourceSchema>
export type TrackedResourceSource = 'delivery' | 'tracked'
export interface ResolvedTrackedResource extends Omit<TrackedResource, 'delivery'> {
  key: string
  source: TrackedResourceSource
  url?: string
  /** True for the codeHost PR and any tracked PR explicitly flagged as a delivery change request. */
  delivery: boolean
}
export const deliveryPullRequestStateSchema = z
  .object({
    state: z.enum(['open', 'merged', 'closed']),
    at: z.string().max(64),
    headSha: z.string().max(64).optional(),
    eventId: z.string().uuid().optional(),
  })
  .strict()
export const workStreamDeliveryStateSchema = z
  .object({
    pullRequests: z.record(z.string(), deliveryPullRequestStateSchema),
  })
  .strict()
export type WorkStreamDeliveryState = z.infer<typeof workStreamDeliveryStateSchema>
/** Parses the work stream's delivery state, defaulting to an empty map when absent or invalid. */
export function readDeliveryState(metadata: unknown): WorkStreamDeliveryState {
  const record =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {}
  const parsed = workStreamDeliveryStateSchema.safeParse(record.delivery)
  return parsed.success ? parsed.data : { pullRequests: {} }
}
export interface DeliveryPullRequestView {
  key: string
  repository: string
  number: number
  url?: string
  primary: boolean
  state: 'open' | 'merged' | 'closed'
  at?: string
  headSha?: string
}
export interface TrackedResourcesView {
  resources: Array<
    ResolvedTrackedResource & {
      subscriptionIds: string[]
      subscribed: boolean
      mergeState?: 'open' | 'merged' | 'closed'
    }
  >
  /** Why subscriptions may be inactive even though links exist. */
  subscriptions: 'active' | 'no-flow' | 'not-following' | 'ended'
  delivery: {
    pullRequests: DeliveryPullRequestView[]
    complete: boolean
  }
}
export function trackedResourceKey(r: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number'>) {
  return `${r.integration}:${r.repository.trim().toLowerCase()}:${r.kind}:${r.number}`
}
export function trackedResourceUrl(r: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number' | 'url'>) {
  if (r.url) return r.url
  if (r.integration !== 'github') return undefined
  return `https://github.com/${r.repository.trim()}/${r.kind === 'issue' ? 'issues' : 'pull'}/${r.number}`
}
export function resolveTrackedResources(metadata: unknown): ResolvedTrackedResource[] {
  const out: ResolvedTrackedResource[] = []
  const seen = new Set<string>()
  const push = (entry: TrackedResource, source: TrackedResourceSource, delivery: boolean) => {
    const key = trackedResourceKey(entry)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...entry, key, source, url: trackedResourceUrl(entry), delivery })
  }
  const reference = resolveCodeHostReference(metadata)
  if (reference?.changeRequest)
    push(
      {
        integration: reference.integration,
        repository: reference.repository,
        kind: 'pull_request',
        number: reference.changeRequest.number,
        ...(reference.connectionId ? { connectionId: reference.connectionId } : {}),
        ...(reference.changeRequest.url ? { url: reference.changeRequest.url } : {}),
      },
      'delivery',
      true
    )
  const tracked =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).tracked
      : undefined
  if (Array.isArray(tracked))
    for (const raw of tracked) {
      const parsed = trackedResourceSchema.safeParse(raw)
      if (parsed.success) push(parsed.data, 'tracked', !!parsed.data.delivery)
    }
  return out
}
/** Pull requests designated as delivery change requests: the codeHost binding plus any flagged tracked PRs, primary first. */
export function deliveryPullRequests(metadata: unknown): ResolvedTrackedResource[] {
  // resolveTrackedResources always yields the codeHost-bound delivery PR first, so this preserves primary-first order.
  return resolveTrackedResources(metadata).filter((resource) => resource.kind === 'pull_request' && resource.delivery)
}
/** The codeHost-bound delivery pull request, if any. */
export function primaryDeliveryPullRequest(metadata: unknown): ResolvedTrackedResource | null {
  return resolveTrackedResources(metadata).find((resource) => resource.source === 'delivery') ?? null
}
const GITHUB_RESOURCE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/i
export function parseTrackedResourceUrl(url: string) {
  const match = GITHUB_RESOURCE_URL.exec(url.trim())
  if (!match) return null
  const number = Number(match[3])
  if (!Number.isSafeInteger(number)) return null
  return {
    integration: 'github' as const,
    repository: match[1]!.toLowerCase(),
    kind: (match[2]!.toLowerCase() === 'issues' ? 'issue' : 'pull_request') as TrackedResourceKind,
    number,
  }
}
export function trackedResourceMatches(
  resource: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number' | 'connectionId'>,
  target: { integration: string; repository: string; kind: TrackedResourceKind; number: number; connectionId?: string }
): boolean {
  return (
    resource.integration === target.integration &&
    resource.kind === target.kind &&
    resource.number === target.number &&
    resource.repository.trim().toLowerCase() === target.repository.trim().toLowerCase() &&
    (!resource.connectionId || !target.connectionId || resource.connectionId === target.connectionId)
  )
}
