import { isDeepStrictEqual } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  parseTrackedResourceUrl,
  resolveTrackedResources,
  trackedResourceKey,
  trackedResourceSchema,
  type IntegrationSubscription,
  type ResolvedTrackedResource,
  type TrackedResource,
  type TrackedResourceKind,
  type TrackedResourcesView,
} from '@tau/shared'
import { db, squads, workStreams, workStreamFlowRuns, integrationOutputEvents, type DbTx } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { codeHostingRegistry } from '../integrations/code-hosting'
import { isOutputEventAuthorizedForSquad, reconcileOutputDeliveries } from '../integrations/outputs/runtime'
import { eventTrackedResource } from '../integrations/outputs/tracked-match'

/** A tracked-link failure that maps directly onto an API status. */
export class TrackedResourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409
  ) {
    super(message)
    this.name = 'TrackedResourceError'
  }
}

const trackedResourceInputSchema = trackedResourceSchema.pick({
  integration: true,
  repository: true,
  kind: true,
  number: true,
  connectionId: true,
  url: true,
})
/** Identity may arrive as an observed event, a resource URL, or an explicit reference. */
export const trackedResourceRequestSchema = z.union([
  z.object({ event: z.string().uuid() }).strict(),
  z.object({ url: z.string().url() }).strict(),
  z.object({ resource: trackedResourceInputSchema }).strict(),
])
export type TrackedResourceRequest = z.infer<typeof trackedResourceRequestSchema>

export interface TrackedResourceTarget {
  integration: string
  repository: string
  kind: TrackedResourceKind
  number: number
}

/** Correlation is not access: the squad must own the connection that observed the event. */
export async function resolveEventTrackedResource(eventId: string, squadId: string): Promise<TrackedResource> {
  const [event] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, eventId))
  if (!event) throw new TrackedResourceError('Integration event not found', 404)
  if (event.authority.kind !== 'connection' || event.authority.squadId !== squadId)
    throw new TrackedResourceError('Event is not accessible from this squad', 403)
  if (!(await isOutputEventAuthorizedForSquad(event, squadId)))
    throw new TrackedResourceError('Event connection is not authorized for this squad', 403)
  const target = eventTrackedResource(event)
  if (!target) throw new TrackedResourceError('Event does not reference a trackable issue or pull request', 400)
  const parsed = trackedResourceSchema.safeParse({
    ...target,
    connectionId: event.authority.connectionId,
    origin: {
      eventId: event.id,
      resourceKey: event.fact.resourceKey,
      output: event.fact.output,
      ...(event.fact.occurredAt ? { occurredAt: event.fact.occurredAt } : {}),
    },
  })
  if (!parsed.success) throw new TrackedResourceError('Event does not reference a trackable issue or pull request', 400)
  return parsed.data
}

/** Identity resolution first, then the squad's own authorization. */
export async function resolveTrackedResourceRequest(
  squadId: string,
  request: TrackedResourceRequest
): Promise<TrackedResource> {
  if ('event' in request) return resolveEventTrackedResource(request.event, squadId)
  let resource: TrackedResource
  if ('url' in request) {
    const parsed = parseTrackedResourceUrl(request.url)
    if (!parsed) throw new TrackedResourceError('Link is not a supported issue or pull request URL', 400)
    resource = { ...parsed, url: request.url.trim() }
  } else {
    resource = request.resource
  }
  await authorizeTrackedResource(squadId, resource)
  return resource
}

/** Access comes from the squad's connection assignment, never from the link itself. */
export async function authorizeTrackedResource(squadId: string, resource: TrackedResource): Promise<void> {
  const adapter = codeHostingRegistry.adapterFor(resource.integration)
  if (!adapter) throw new TrackedResourceError(`Unknown code hosting integration: ${resource.integration}`, 400)
  if (!adapter.validateRepository(resource.repository))
    throw new TrackedResourceError(`Invalid ${resource.integration} repository: ${resource.repository}`, 400)
  if (adapter.authorizeSquad && !(await adapter.authorizeSquad(squadId, resource.connectionId)))
    throw new TrackedResourceError(
      `No authorized ${resource.integration} connection is assigned to this squad${
        resource.connectionId ? ' for the requested account' : ''
      }`,
      403
    )
}

/**
 * Shape-only validation: rewrites `metadata.tracked` with parsed entries and returns them
 * (null when the key is absent). Reads nothing, so it is safe to call while holding a row lock.
 */
export function parseTrackedMetadata(metadata: Record<string, unknown>): TrackedResource[] | null {
  if (!Object.prototype.hasOwnProperty.call(metadata, 'tracked')) return null
  const raw = metadata.tracked
  if (!Array.isArray(raw)) throw new TrackedResourceError('metadata.tracked must be an array', 400)
  const parsed: TrackedResource[] = []
  for (const [index, entry] of raw.entries()) {
    const result = trackedResourceSchema.safeParse(entry)
    if (!result.success)
      throw new TrackedResourceError(
        `metadata.tracked[${index}] is invalid: ${result.error.issues[0]?.message ?? 'unrecognized shape'}`,
        400
      )
    parsed.push(result.data)
  }
  metadata.tracked = parsed
  return parsed
}

/** The `tracked` entries already stored, by identity. First entry wins, like `mergeTracked`. */
function storedTrackedEntries(previous: unknown): Map<string, TrackedResource> {
  const stored = new Map<string, TrackedResource>()
  const raw = previous && typeof previous === 'object' ? (previous as Record<string, unknown>).tracked : undefined
  if (!Array.isArray(raw)) return stored
  for (const entry of raw) {
    const parsed = trackedResourceSchema.safeParse(entry)
    if (!parsed.success) continue
    const key = trackedResourceKey(parsed.data)
    if (!stored.has(key)) stored.set(key, parsed.data)
  }
  return stored
}

/**
 * Validate every `metadata.tracked` entry and authorize the ones this write introduces.
 * Entries already present in `previous` keep their access: they were authorized when added.
 * Authorization reads the squad's connections, so callers must run this BEFORE opening a
 * transaction: the provider lookup locks the squad row on its own connection.
 */
export async function validateTrackedMetadata(
  squadId: string,
  metadata: Record<string, unknown>,
  previous?: unknown,
  options?: { allowOriginEventId?: string }
): Promise<void> {
  const parsed = parseTrackedMetadata(metadata)
  if (!parsed) return
  // Access carries over from anything already resolvable, including the delivery PR and legacy issue.
  const previousKeys = new Set(resolveTrackedResources(previous).map((resource) => resource.key))
  // `origin` carries over only from a stored `tracked` entry: the delivery PR and legacy issue
  // resolve without one, so re-submitting them counts as introducing an origin.
  const stored = storedTrackedEntries(previous)
  for (const [index, resource] of parsed.entries()) {
    const key = trackedResourceKey(resource)
    // `origin` is the server's record of the event it observed. A client may keep one exactly as
    // stored; it can never add, rewrite, or drop one, whether or not the identity already exists.
    const storedEntry = stored.get(key)
    const forged = storedEntry
      ? !isDeepStrictEqual(resource.origin, storedEntry.origin)
      : !!resource.origin && resource.origin.eventId !== options?.allowOriginEventId
    if (forged) throw new TrackedResourceError(`metadata.tracked[${index}].origin is server-managed`, 400)
    if (previousKeys.has(key)) continue
    await authorizeTrackedResource(squadId, resource)
  }
}

/**
 * Pure: dedupe by identity, keep order, stamp `addedAt` only on entries that lack it.
 * The FIRST list wins a collision, so callers put the entry they trust first.
 */
export function mergeTracked(existing: unknown, additions: unknown): TrackedResource[] {
  const addedAt = new Date().toISOString()
  const merged: TrackedResource[] = []
  const seen = new Set<string>()
  for (const list of [existing, additions]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const parsed = trackedResourceSchema.safeParse(entry)
      if (!parsed.success) continue
      const key = trackedResourceKey(parsed.data)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(parsed.data.addedAt ? parsed.data : { ...parsed.data, addedAt })
    }
  }
  return merged
}

type LockedStream = typeof workStreams.$inferSelect
/** Squad row first, then the stream row: the same lock order every other writer uses. */
async function withLockedStream<T>(
  streamId: string,
  fn: (locked: LockedStream, tx: DbTx) => Promise<{ value: T; changed: boolean }>
): Promise<T> {
  let squadId = ''
  const { value, changed } = await db.transaction(async (tx) => {
    const [reference] = await tx
      .select({ squadId: workStreams.squadId })
      .from(workStreams)
      .where(eq(workStreams.id, streamId))
    if (!reference) throw new TrackedResourceError('Work stream not found', 404)
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, reference.squadId)).for('update')
    const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, streamId)).for('update')
    if (!locked) throw new TrackedResourceError('Work stream not found', 404)
    squadId = locked.squadId
    return fn(locked, tx)
  })
  if (changed) {
    eventEmitter.emit('workStream.updated', { workStreamId: streamId, squadId })
    await reconcileOutputDeliveries(streamId)
  }
  return value
}

export async function addTrackedResources(
  streamId: string,
  resources: TrackedResource[]
): Promise<{ added: ResolvedTrackedResource[]; view: TrackedResourcesView }> {
  const addedKeys = await withLockedStream(streamId, async (locked, tx) => {
    const metadata = (locked.metadata as Record<string, unknown> | null) ?? {}
    const current = new Set(resolveTrackedResources(metadata).map((resource) => resource.key))
    const additions = resources.filter((resource) => !current.has(trackedResourceKey(resource)))
    if (!additions.length) return { value: [] as string[], changed: false }
    const tracked = mergeTracked(metadata.tracked, additions)
    await tx
      .update(workStreams)
      .set({ metadata: { ...metadata, tracked }, updatedAt: new Date() })
      .where(eq(workStreams.id, streamId))
    return { value: additions.map((resource) => trackedResourceKey(resource)), changed: true }
  })
  const view = await listTrackedResources(streamId)
  return { added: view.resources.filter((resource) => addedKeys.includes(resource.key)), view }
}

export async function removeTrackedResource(
  streamId: string,
  target: TrackedResourceTarget
): Promise<{ removed: boolean; view: TrackedResourcesView }> {
  const key = trackedResourceKey(target)
  const removed = await withLockedStream(streamId, async (locked, tx) => {
    const metadata = (locked.metadata as Record<string, unknown> | null) ?? {}
    const resource = resolveTrackedResources(metadata).find((entry) => entry.key === key)
    if (!resource) return { value: false, changed: false }
    if (resource.source === 'delivery')
      throw new TrackedResourceError(
        'This pull request is the designated delivery change request; edit codeHost.changeRequest instead of untracking it',
        409
      )
    const next: Record<string, unknown> = { ...metadata }
    if (Array.isArray(next.tracked))
      next.tracked = next.tracked.filter((entry) => {
        const parsed = trackedResourceSchema.safeParse(entry)
        return !parsed.success || trackedResourceKey(parsed.data) !== key
      })
    if (resource.source === 'legacy-issue') {
      const github = { ...((next.github as Record<string, unknown> | undefined) ?? {}) }
      delete github.issue
      next.github = github
    }
    await tx.update(workStreams).set({ metadata: next, updatedAt: new Date() }).where(eq(workStreams.id, streamId))
    return { value: true, changed: true }
  })
  return { removed, view: await listTrackedResources(streamId) }
}

function matchValue(subscription: IntegrationSubscription, path: string) {
  const match = subscription.match[path]
  return match && 'value' in match ? match.value : undefined
}

export async function listTrackedResources(streamId: string): Promise<TrackedResourcesView> {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
  if (!stream) throw new TrackedResourceError('Work stream not found', 404)
  const [run] = await db
    .select({ state: workStreamFlowRuns.state })
    .from(workStreamFlowRuns)
    .where(eq(workStreamFlowRuns.workStreamId, streamId))
  const subscriptions: TrackedResourcesView['subscriptions'] = !['active', 'queued'].includes(stream.status)
    ? 'ended'
    : !run
      ? 'no-flow'
      : !run.state.definition.completion.followChanges
        ? 'not-following'
        : 'active'
  const active =
    subscriptions === 'active' ? codeHostingRegistry.subscriptions(run!.state.definition, stream.metadata) : []
  return {
    subscriptions,
    resources: resolveTrackedResources(stream.metadata).map((resource) => {
      const repository = resource.repository.trim().toLowerCase()
      const numberPath = resource.kind === 'issue' ? 'issue.number' : 'pullRequest.number'
      const subscriptionIds = active
        .filter(
          (subscription) =>
            subscription.source.integration === resource.integration &&
            String(matchValue(subscription, 'repository') ?? '').toLowerCase() === repository &&
            matchValue(subscription, numberPath) === resource.number
        )
        .map((subscription) => subscription.id)
      return { ...resource, subscriptionIds, subscribed: subscriptionIds.length > 0 }
    }),
  }
}
