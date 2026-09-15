import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { createBlankWorkflow, trackedResourceKey, type IntegrationOutputFact, type TrackedResource } from '@tau/shared'
import {
  db,
  agents,
  agentTypes,
  inbox,
  squads,
  workStreams,
  integrationConnections,
  integrationOutputDeliveries,
  integrationOutputEvents,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'
import { createTestGitHubConnection } from '../../test-utils/github-connection'
import { attachFlow, dispatchFlow } from '../workflows/execution'
import { publishIntegrationOutput } from '../integrations/outputs/runtime'
import type { IntegrationOutputAuthority } from '../integrations/outputs/types'
import {
  TrackedResourceError,
  addTrackedResources,
  authorizeTrackedResource,
  listTrackedResources,
  mergeTracked,
  removeTrackedResource,
  resolveEventTrackedResource,
  resolveTrackedResourceRequest,
  validateTrackedMetadata,
} from './tracked-resources'

const prefix = `tracked-${randomUUID()}`
const repo = `${prefix}/repo`
const eventIds: string[] = []
let squadId: string
let otherSquadId: string
let connectionId: string
let connectionRevision: string
let fixtures: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>

function issueFact(number: number, changes: Partial<IntegrationOutputFact> = {}): IntegrationOutputFact {
  return {
    output: 'issue.assigned',
    version: 1,
    eventKey: randomUUID(),
    resourceKey: `${repo}#${number}`,
    occurredAt: new Date().toISOString(),
    data: { repository: repo, issue: { number }, assignee: 'tau-bot' },
    subject: `Issue ${repo}#${number}`,
    body: 'Please take a look.',
    ...changes,
  }
}
async function insertEvent(fact: IntegrationOutputFact, authority: IntegrationOutputAuthority) {
  const [row] = await db
    .insert(integrationOutputEvents)
    .values({
      integration: 'github',
      sourceKey: `github:${prefix}`,
      eventKey: fact.eventKey,
      authority,
      fact,
    })
    .returning()
  eventIds.push(row!.id)
  return row!
}
function trackedIssue(number: number, repository = repo): TrackedResource {
  return { integration: 'github', repository, kind: 'issue', number }
}
async function createStream(
  options: { metadata?: Record<string, unknown>; flow?: 'follow' | 'no-follow'; status?: 'active' | 'done' } = {}
) {
  return db.transaction(async (tx) => {
    const [stream] = await tx
      .insert(workStreams)
      .values({
        squadId,
        title: prefix,
        status: options.status ?? 'active',
        metadata: options.metadata ?? {},
      })
      .returning()
    if (options.flow) {
      const definition = createBlankWorkflow()
      definition.participants.worker!.agentTypeId = prefix
      definition.completion.followChanges = options.flow === 'follow'
      const run = await attachFlow(tx, stream!, { kind: 'inline', definition })
      await dispatchFlow(tx, stream!, run, [])
    }
    return stream!.id
  })
}
async function metadataOf(id: string) {
  return (await WorkStream.mustFind(id)).metadata as Record<string, any>
}

beforeAll(async () => {
  await db.insert(agentTypes).values({
    id: prefix,
    name: 'Tracked resource fixture worker',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test worker',
  })
  squadId = (await db.insert(squads).values({ name: prefix, purpose: 'Tracked resource fixtures' }).returning())[0]!.id
  otherSquadId = (
    await db
      .insert(squads)
      .values({ name: `${prefix}-other`, purpose: 'Tracked resource fixtures' })
      .returning()
  )[0]!.id
  const fixture = await createTestGitHubConnection({ squadId })
  fixtures.push(fixture)
  connectionId = fixture.id
  const [connection] = await db
    .select({ materialRevision: integrationConnections.materialRevision })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
  connectionRevision = connection!.materialRevision
  send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({ success: true, queued: true, status: 'queued' })
})
afterAll(async () => {
  send?.mockRestore()
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(inArray(agents.squadId, [squadId, otherSquadId]))
  if (owned.length)
    await db.delete(inbox).where(
      inArray(
        inbox.recipientId,
        owned.map((row) => row.id)
      )
    )
  await db.delete(workStreams).where(inArray(workStreams.squadId, [squadId, otherSquadId]))
  await db.delete(agents).where(inArray(agents.squadId, [squadId, otherSquadId]))
  for (const fixture of fixtures) await fixture.dispose()
  fixtures = []
  await db.delete(squads).where(inArray(squads.id, [squadId, otherSquadId]))
  await db.delete(agentTypes).where(eq(agentTypes.id, prefix))
  if (eventIds.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
})

test('an event resolves to a tracked issue only for the squad whose live connection observed it', async () => {
  const fact = issueFact(2101)
  const event = await insertEvent(fact, { kind: 'connection', connectionId, squadId, connectionRevision })
  expect(await resolveEventTrackedResource(event.id, squadId)).toEqual({
    integration: 'github',
    repository: repo,
    kind: 'issue',
    number: 2101,
    connectionId,
    url: `https://github.com/${repo}/issues/2101`,
    origin: {
      eventId: event.id,
      resourceKey: fact.resourceKey,
      output: 'issue.assigned',
      occurredAt: fact.occurredAt,
    },
  })
  await expect(resolveEventTrackedResource(event.id, otherSquadId)).rejects.toMatchObject({
    name: 'TrackedResourceError',
    status: 403,
  })
  await expect(resolveEventTrackedResource(randomUUID(), squadId)).rejects.toMatchObject({ status: 404 })
  const instance = await insertEvent(issueFact(2102), { kind: 'instance' })
  await expect(resolveEventTrackedResource(instance.id, squadId)).rejects.toMatchObject({ status: 403 })
  // Authority names this squad, but the connection is not assigned to it.
  const unassigned = await createTestGitHubConnection({ login: 'unassigned' })
  fixtures.push(unassigned)
  const foreign = await insertEvent(issueFact(2103), {
    kind: 'connection',
    connectionId: unassigned.id,
    squadId,
  })
  await expect(resolveEventTrackedResource(foreign.id, squadId)).rejects.toMatchObject({ status: 403 })
  const untrackable = await insertEvent(issueFact(2104, { data: { repository: repo, assignee: 'tau-bot' } }), {
    kind: 'connection',
    connectionId,
    squadId,
    connectionRevision,
  })
  await expect(resolveEventTrackedResource(untrackable.id, squadId)).rejects.toMatchObject({ status: 400 })
})

test('authorization comes from the squad connection, not from the resource identity', async () => {
  await authorizeTrackedResource(squadId, trackedIssue(2110))
  await expect(authorizeTrackedResource(otherSquadId, trackedIssue(2110))).rejects.toMatchObject({ status: 403 })
  await expect(
    authorizeTrackedResource(squadId, { ...trackedIssue(2110), integration: 'bitbucket' })
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    authorizeTrackedResource(squadId, { ...trackedIssue(2110), repository: 'not a repo' })
  ).rejects.toMatchObject({ status: 400 })
  // A URL request resolves to the same identity and is authorized the same way.
  expect(await resolveTrackedResourceRequest(squadId, { url: `https://github.com/${repo}/pull/2111` })).toMatchObject({
    integration: 'github',
    repository: repo,
    kind: 'pull_request',
    number: 2111,
  })
  await expect(resolveTrackedResourceRequest(squadId, { url: 'https://example.com/x' })).rejects.toMatchObject({
    status: 400,
  })
})

test('adding the same link twice is a no-op and concurrent adds of different links both land', async () => {
  const id = await createStream()
  const first = await addTrackedResources(id, [trackedIssue(2201)])
  expect(first.added.map((resource) => resource.key)).toEqual([trackedResourceKey(trackedIssue(2201))])
  expect(first.view.resources).toHaveLength(1)
  const addedAt = (await metadataOf(id)).tracked[0].addedAt
  expect(addedAt).toBeString()
  const second = await addTrackedResources(id, [trackedIssue(2201)])
  expect(second.added).toEqual([])
  expect(second.view.resources).toHaveLength(1)
  expect((await metadataOf(id)).tracked[0].addedAt).toBe(addedAt)

  const concurrent = await createStream()
  await Promise.all([
    addTrackedResources(concurrent, [trackedIssue(2202)]),
    addTrackedResources(concurrent, [trackedIssue(2203)]),
  ])
  expect((await listTrackedResources(concurrent)).resources.map((resource) => resource.number).sort()).toEqual([
    2202, 2203,
  ])
})

test('mergeTracked keeps existing entries and their stamps while deduping by identity', () => {
  const existing = [{ ...trackedIssue(2210), addedAt: '2024-01-01T00:00:00.000Z' }]
  const merged = mergeTracked(existing, [trackedIssue(2210), trackedIssue(2211)])
  expect(merged).toHaveLength(2)
  expect(merged[0]).toEqual(existing[0]!)
  expect(merged[1]!.number).toBe(2211)
  expect(merged[1]!.addedAt).toBeString()
  expect(mergeTracked(undefined, [])).toEqual([])
})

test('the delivery change request cannot be untracked, and a legacy issue link keeps its repository', async () => {
  const delivery = await createStream({
    metadata: { codeHost: { integration: 'github', repository: repo, changeRequest: { number: 2301 } } },
  })
  await expect(
    removeTrackedResource(delivery, { integration: 'github', repository: repo, kind: 'pull_request', number: 2301 })
  ).rejects.toMatchObject({ status: 409 })
  expect((await metadataOf(delivery)).codeHost.changeRequest.number).toBe(2301)

  const legacy = await createStream({ metadata: { github: { repo, issue: 2302 } } })
  const removed = await removeTrackedResource(legacy, {
    integration: 'github',
    repository: repo,
    kind: 'issue',
    number: 2302,
  })
  expect(removed.removed).toBe(true)
  expect(removed.view.resources).toEqual([])
  const metadata = await metadataOf(legacy)
  expect(metadata.github.issue).toBeUndefined()
  expect(metadata.github.repo).toBe(repo)

  const missing = await createStream()
  expect((await removeTrackedResource(missing, { ...trackedIssue(2303) })).removed).toBe(false)
})

test('removing a tracked link supersedes its pending deliveries', async () => {
  const resource = trackedIssue(2310)
  const id = await createStream({ metadata: { tracked: [resource] }, flow: 'follow' })
  eventIds.push(
    (await publishIntegrationOutput('github', issueFact(2310, { output: 'issue.updated' }), {
      kind: 'connection',
      connectionId,
      squadId,
    }))!
  )
  const before = await db
    .select()
    .from(integrationOutputDeliveries)
    .where(eq(integrationOutputDeliveries.workStreamId, id))
  expect(before).toHaveLength(1)
  expect(before[0]!.status).not.toBe('superseded')
  const result = await removeTrackedResource(id, {
    integration: 'github',
    repository: repo,
    kind: 'issue',
    number: 2310,
  })
  expect(result.removed).toBe(true)
  expect(result.view.resources).toEqual([])
  expect((await metadataOf(id)).tracked).toEqual([])
  const after = await db
    .select()
    .from(integrationOutputDeliveries)
    .where(eq(integrationOutputDeliveries.workStreamId, id))
  expect(after[0]).toMatchObject({ status: 'superseded', reason: 'Subscription changed' })
})

test('the view explains why links are not subscribed', async () => {
  const resource = trackedIssue(2401)
  const noFlow = await listTrackedResources(await createStream({ metadata: { tracked: [resource] } }))
  expect(noFlow.subscriptions).toBe('no-flow')
  expect(noFlow.resources.map((item) => item.subscribed)).toEqual([false])

  const notFollowing = await listTrackedResources(
    await createStream({ metadata: { tracked: [resource] }, flow: 'no-follow' })
  )
  expect(notFollowing.subscriptions).toBe('not-following')
  expect(notFollowing.resources.every((item) => !item.subscribed && item.subscriptionIds.length === 0)).toBe(true)

  const active = await listTrackedResources(await createStream({ metadata: { tracked: [resource] }, flow: 'follow' }))
  expect(active.subscriptions).toBe('active')
  expect(active.resources).toHaveLength(1)
  expect(active.resources[0]!.subscribed).toBe(true)
  expect(active.resources[0]!.subscriptionIds.length).toBeGreaterThan(0)

  const ended = await createStream({ metadata: { tracked: [resource] }, flow: 'follow' })
  await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, ended))
  const endedView = await listTrackedResources(ended)
  expect(endedView.subscriptions).toBe('ended')
  expect(endedView.resources.map((item) => item.subscribed)).toEqual([false])

  await expect(listTrackedResources(randomUUID())).rejects.toMatchObject({ status: 404 })
})

test('tracked metadata is validated on write and only new entries are authorized', async () => {
  await expect(validateTrackedMetadata(squadId, { tracked: [{ bad: true }] })).rejects.toMatchObject({ status: 400 })
  await expect(validateTrackedMetadata(squadId, { tracked: 'nope' })).rejects.toMatchObject({ status: 400 })
  await expect(validateTrackedMetadata(otherSquadId, { tracked: [trackedIssue(2501)] })).rejects.toMatchObject({
    status: 403,
  })
  // An unchanged entry is never re-authorized, so a squad that lost its connection can still be updated.
  const metadata: Record<string, unknown> = {
    tracked: [{ ...trackedIssue(2501), addedAt: '2024-01-01T00:00:00.000Z' }],
  }
  await validateTrackedMetadata(otherSquadId, metadata, { tracked: [trackedIssue(2501)] })
  expect(metadata.tracked).toEqual([{ ...trackedIssue(2501), addedAt: '2024-01-01T00:00:00.000Z' }])
  await validateTrackedMetadata(otherSquadId, { title: 'no tracked key' })
  expect(new TrackedResourceError('nope', 409).status).toBe(409)
})
