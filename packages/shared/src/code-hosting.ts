import { z } from 'zod'
import { integrationValueAt } from './integration-outputs'

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
export const trackedResourceSchema = z
  .object({
    integration: integrationName,
    repository: z.string().trim().min(1).max(500),
    kind: z.enum(TRACKED_RESOURCE_KINDS),
    number: z.number().int().positive().safe(),
    connectionId: z.string().uuid().optional(),
    url: z.string().url().max(2000).optional(),
    addedAt: z.string().max(64).optional(),
    origin: trackedResourceOriginSchema.optional(),
  })
  .strict()
export type TrackedResource = z.infer<typeof trackedResourceSchema>
export type TrackedResourceSource = 'delivery' | 'legacy-issue' | 'tracked'
export interface ResolvedTrackedResource extends TrackedResource {
  key: string
  source: TrackedResourceSource
  url?: string
}
export interface TrackedResourcesView {
  resources: Array<ResolvedTrackedResource & { subscriptionIds: string[]; subscribed: boolean }>
  /** Why subscriptions may be inactive even though links exist. */
  subscriptions: 'active' | 'no-flow' | 'not-following' | 'ended'
}
export function trackedResourceKey(r: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number'>) {
  return `${r.integration}:${r.repository.trim().toLowerCase()}:${r.kind}:${r.number}`
}
export function trackedResourceUrl(r: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number' | 'url'>) {
  if (r.url) return r.url
  if (r.integration !== 'github') return undefined
  return `https://github.com/${r.repository.trim()}/${r.kind === 'issue' ? 'issues' : 'pull'}/${r.number}`
}
/** Shared issue identity for subscriptions and existing-stream matching; never grants access. */
export function resolveGitHubIssueReference(
  metadata: unknown,
  reference: CodeHostReference | null = resolveCodeHostReference(metadata)
) {
  if (reference?.integration !== 'github') return null
  const repository = integrationValueAt(metadata, 'github.repo')
  const rawNumber = integrationValueAt(metadata, 'github.issue')
  if (typeof repository !== 'string' || repository.toLowerCase() !== reference.repository.toLowerCase()) return null
  if (typeof rawNumber !== 'number' && !(typeof rawNumber === 'string' && /^[1-9][0-9]*$/.test(rawNumber))) return null
  const number = Number(rawNumber)
  if (!Number.isSafeInteger(number) || number <= 0) return null
  const originMatches =
    integrationValueAt(metadata, 'integrationSource.integration') === 'github' &&
    integrationValueAt(metadata, 'integrationSource.resourceKey') === `${repository.toLowerCase()}#${number}`
  const connectionId =
    integrationValueAt(metadata, 'github.connectionId') ??
    reference.connectionId ??
    (originMatches ? integrationValueAt(metadata, 'integrationSource.connectionId') : undefined)
  const identity = codeHostReferenceSchema.safeParse({ ...reference, connectionId })
  return identity.success
    ? { repository: repository.toLowerCase(), number, connectionId: identity.data.connectionId }
    : null
}
export function resolveTrackedResources(metadata: unknown): ResolvedTrackedResource[] {
  const out: ResolvedTrackedResource[] = []
  const seen = new Set<string>()
  const push = (entry: TrackedResource, source: TrackedResourceSource) => {
    const key = trackedResourceKey(entry)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...entry, key, source, url: trackedResourceUrl(entry) })
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
      'delivery'
    )
  const issue = resolveGitHubIssueReference(metadata, reference)
  if (issue)
    push(
      {
        integration: 'github',
        repository: issue.repository,
        kind: 'issue',
        number: issue.number,
        ...(issue.connectionId ? { connectionId: issue.connectionId } : {}),
      },
      'legacy-issue'
    )
  const tracked =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).tracked
      : undefined
  if (Array.isArray(tracked))
    for (const raw of tracked) {
      const parsed = trackedResourceSchema.safeParse(raw)
      if (parsed.success) push(parsed.data, 'tracked')
    }
  return out
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
