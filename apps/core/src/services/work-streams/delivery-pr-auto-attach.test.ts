import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray, like } from 'drizzle-orm'
import { createBlankWorkflow, type IntegrationOutputFact, type WorkflowDefinition } from '@tau/shared'
import {
  db,
  agents,
  agentTypes,
  inbox,
  integrationConnections,
  integrationConnectionAssignments,
  integrationOutputEvents,
  squads,
  workStreams,
} from '../../db'
import { attachFlow } from '../workflows/execution'
import { publishIntegrationOutput } from '../integrations/outputs/runtime'
import {
  autoAttachDeliveryPrBinding,
  deliveryPrBindingEvent,
  evaluateDeliveryPrBinding,
  planDeliveryPrBinding,
} from './delivery-pr-auto-attach'

const prefix = `pr-binding-${randomUUID()}`
const repo = `${prefix}/repo`
const branch = `work/${prefix}`
const otherBranch = `work/${prefix}-other`
const eventIds: string[] = []
let squadId: string
let agentTypeId: string
let recipientId: string
let connectionId: string

/** opened/synchronize facts shaped exactly like githubOutputAdapter.normalize output. */
function prFact(
  changes: { number?: number; action?: string; headBranch?: string; baseBranch?: string | false } = {}
): IntegrationOutputFact {
  const number = changes.number ?? 42
  const headBranch = changes.headBranch ?? branch
  const baseBranch = changes.baseBranch === undefined ? 'main' : changes.baseBranch
  return {
    output: 'pull_request.updated',
    version: 1,
    eventKey: randomUUID(),
    resourceKey: `${repo}#${number}`,
    occurredAt: new Date().toISOString(),
    data: {
      repository: repo,
      pullRequest: { number, headSha: 'a'.repeat(40) },
      action: changes.action ?? 'opened',
      headBranch,
      ...(baseBranch ? { baseBranch } : {}),
    },
    subject: `Pull request updated: ${repo}#${number}`,
    body: '',
    url: `https://github.com/${repo}/pull/${number}`,
  }
}

async function publish(fact: IntegrationOutputFact): Promise<string> {
  const id = (await publishIntegrationOutput('github', fact, { kind: 'connection', connectionId, squadId }))!
  eventIds.push(id)
  return id
}

/** An active stream with an activated flow run for the given completion mode and branch. */
async function createStream(options: {
  mode?: 'pr-merge' | 'pr-auto-merge' | 'deliverable' | 'review-approval' | 'direct-merge'
  status?: 'active' | 'queued' | 'done' | 'canceled'
  branch?: string
  metadata?: Record<string, unknown>
}): Promise<string> {
  const definition: WorkflowDefinition = createBlankWorkflow()
  definition.participants.worker!.agentTypeId = agentTypeId
  definition.completion.mode = options.mode ?? 'pr-merge'
  const [stream] = await db
    .insert(workStreams)
    .values({
      squadId,
      title: prefix,
      status: options.status ?? 'active',
      ownerAgentId: recipientId,
      metadata: {
        git: { branch: options.branch ?? branch, baseBranch: 'main' },
        codeHost: { integration: 'github', repository: repo },
        ...(options.metadata ?? {}),
      },
    })
    .returning()
  await db.transaction(async (tx) => {
    await attachFlow(tx, stream!, { kind: 'inline', definition })
  })
  return stream!.id
}

async function metadataOf(id: string) {
  const [row] = await db.select({ metadata: workStreams.metadata }).from(workStreams).where(eq(workStreams.id, id))
  return row!.metadata as Record<string, any>
}

async function bindingNotifications() {
  return db
    .select()
    .from(inbox)
    .where(like(inbox.idempotencyKey, `pr-binding-%:${prefix}%`))
}

beforeAll(async () => {
  agentTypeId = `${prefix}-worker`
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'PR binding fixtures' }).returning()
  squadId = squad!.id
  await db
    .insert(agentTypes)
    .values({ id: agentTypeId, name: 'PR binding worker', model: 'anthropic:claude-sonnet-4-5', systemPrompt: 'Test.' })
  const [agent] = await db.insert(agents).values({ agentTypeId, squadId, status: 'dormant' }).returning()
  recipientId = agent!.id
  const revision = randomUUID()
  const [connection] = await db
    .insert(integrationConnections)
    .values({
      providerKey: 'github',
      adapterVersion: 1,
      displayName: prefix,
      configuration: {},
      credentialRef: `fixture:${prefix}`,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      materialRevision: revision,
      validatedRevision: revision,
      validationExpiresAt: new Date(Date.now() + 600000),
    })
    .returning()
  connectionId = connection!.id
  await db.insert(integrationConnectionAssignments).values({ squadId, providerKey: 'github', connectionId })
})
afterAll(async () => {
  await db.delete(inbox).where(eq(inbox.recipientId, recipientId))
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db
    .delete(integrationConnectionAssignments)
    .where(eq(integrationConnectionAssignments.connectionId, connectionId))
  await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
  await db.delete(agents).where(eq(agents.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  if (eventIds.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
})

test('a unique branch match binds codeHost.changeRequest and notifies the delivery owner', async () => {
  const id = await createStream({})
  await publish(prFact())
  const metadata = await metadataOf(id)
  expect(metadata.codeHost).toEqual({
    integration: 'github',
    repository: repo,
    changeRequest: { number: 42, url: `https://github.com/${repo}/pull/42` },
  })
  expect(metadata.tracked).toBeUndefined()
  expect(metadata.delivery).toBeUndefined()
  const notifications = await bindingNotifications()
  const attached = notifications.find((row) => row.idempotencyKey === `pr-binding-attach:${id}:${repo}#42`)
  expect(attached).toBeDefined()
  expect(attached!.recipientId).toBe(recipientId)
  expect(attached!.subject).toBe(`Delivery PR auto-bound: ${repo}#42`)
  expect(attached!.content).toContain(`work stream ${id}`)
  expect(attached!.content).toContain('automatically bound')
})

test('repeated events and later synchronize pushes never rebind or renotify', async () => {
  const id = await createStream({ branch: otherBranch })
  await publish(prFact({ number: 7, headBranch: otherBranch }))
  const first = await metadataOf(id)
  expect(first.codeHost.changeRequest).toEqual({ number: 7, url: `https://github.com/${repo}/pull/7` })
  const before = (await bindingNotifications()).length
  // Same PR again (edited), then a new push to the same branch: identity unchanged.
  await publish(prFact({ number: 7, action: 'edited', headBranch: otherBranch }))
  await publish(prFact({ number: 7, action: 'synchronize', headBranch: otherBranch }))
  expect(await metadataOf(id)).toEqual(first)
  expect(await bindingNotifications()).toHaveLength(before)
})

test('multiple matching streams bind none and record the ambiguity on every candidate', async () => {
  const first = await createStream({ branch: 'work/ambiguity-a' })
  const second = await createStream({ branch: 'work/ambiguity-a' })
  await publish(prFact({ number: 9, headBranch: 'work/ambiguity-a' }))
  for (const id of [first, second]) {
    const metadata = await metadataOf(id)
    expect(metadata.codeHost.changeRequest).toBeUndefined()
    expect(metadata.deliveryBinding.autoAttach).toMatchObject({
      status: 'multiple-candidates',
      repository: repo,
      number: 9,
      headBranch: 'work/ambiguity-a',
    })
    const notice = (await bindingNotifications()).find(
      (row) => row.idempotencyKey === `pr-binding-ambiguous:multiple-candidates:${id}:${repo}#9`
    )
    expect(notice).toBeDefined()
    expect(notice!.content).toContain('multiple active work streams')
    expect(notice!.content).toContain(id)
  }
})

test('a reason flip after manual remediation records and notifies instead of colliding on a key', async () => {
  const bound = await createStream({ branch: 'work/ambiguity-b' })
  const waiting = await createStream({ branch: 'work/ambiguity-b' })
  await publish(prFact({ number: 12, headBranch: 'work/ambiguity-b' }))
  // Both candidates recorded multiple-candidates; the operator follows the notification and
  // binds one stream manually, exactly as instructed.
  await db
    .update(workStreams)
    .set({
      metadata: {
        codeHost: { integration: 'github', repository: repo, changeRequest: { number: 12 } },
        git: { branch: 'work/ambiguity-b', baseBranch: 'main' },
      },
    })
    .where(eq(workStreams.id, bound))
  // The next event for the same PR must not throw on a reused idempotency key: the remaining
  // candidate flips to a different-binding ambiguity with its own notification.
  await publish(prFact({ number: 12, action: 'synchronize', headBranch: 'work/ambiguity-b' }))
  const boundMetadata = await metadataOf(bound)
  expect(boundMetadata.codeHost.changeRequest).toEqual({ number: 12 })
  expect(boundMetadata.deliveryBinding).toBeUndefined()
  const waitingMetadata = await metadataOf(waiting)
  expect(waitingMetadata.codeHost.changeRequest).toBeUndefined()
  expect(waitingMetadata.deliveryBinding.autoAttach).toMatchObject({ status: 'different-binding', number: 12 })
  const flip = (await bindingNotifications()).find(
    (row) => row.idempotencyKey === `pr-binding-ambiguous:different-binding:${waiting}:${repo}#12`
  )
  expect(flip).toBeDefined()
  expect(flip!.content).toContain('another work stream is already bound to this pull request')
  // Each reason notified exactly once for the stream.
  const forWaiting = (await bindingNotifications()).filter((row) => row.content.includes(waiting))
  expect(forWaiting).toHaveLength(2)
})

test('a stream bound to a different pull request is never overwritten', async () => {
  const id = await createStream({
    branch: 'work/conflict',
    metadata: { codeHost: { integration: 'github', repository: repo, changeRequest: { number: 5 } } },
  })
  await publish(prFact({ number: 8, headBranch: 'work/conflict' }))
  const metadata = await metadataOf(id)
  expect(metadata.codeHost.changeRequest).toEqual({ number: 5 })
  expect(metadata.deliveryBinding.autoAttach).toMatchObject({ status: 'different-binding', number: 8 })
  const notice = (await bindingNotifications()).find(
    (row) => row.idempotencyKey === `pr-binding-ambiguous:different-binding:${id}:${repo}#8`
  )
  expect(notice).toBeDefined()
  expect(notice!.content).toContain('already bound to a different pull request (#5)')
})

test('non-PR completion modes, terminal statuses, queued streams, wrong repos, and other squads are untouched', async () => {
  const untouched: Array<string> = []
  for (const mode of ['deliverable', 'review-approval', 'direct-merge'] as const)
    untouched.push(await createStream({ mode, branch: 'work/skipped' }))
  untouched.push(await createStream({ status: 'done', branch: 'work/skipped' }))
  untouched.push(await createStream({ status: 'canceled', branch: 'work/skipped' }))
  untouched.push(await createStream({ status: 'queued', branch: 'work/skipped' }))
  untouched.push(
    await createStream({
      branch: 'work/skipped',
      metadata: { codeHost: { integration: 'github', repository: `${prefix}/elsewhere` } },
    })
  )
  untouched.push(
    await createStream({
      branch: 'work/skipped',
      metadata: {
        codeHost: { integration: 'github', repository: repo },
        git: { branch: 'work/skipped', baseBranch: 'release' },
      },
    })
  )
  const before = await bindingNotifications()
  await publish(prFact({ number: 11, headBranch: 'work/skipped' }))
  for (const id of untouched) {
    const metadata = await metadataOf(id)
    expect(metadata.codeHost.changeRequest).toBeUndefined()
    expect(metadata.deliveryBinding).toBeUndefined()
  }
  expect(await bindingNotifications()).toEqual(before)
})

test('instance-authority events never bind', async () => {
  const id = await createStream({ branch: 'work/instance-authority' })
  const [row] = await db
    .insert(integrationOutputEvents)
    .values({
      integration: 'github',
      sourceKey: `github:${prefix}:instance`,
      eventKey: randomUUID(),
      authority: { kind: 'instance' },
      fact: prFact({ number: 13, headBranch: 'work/instance-authority' }),
    })
    .returning()
  eventIds.push(row!.id)
  expect(await autoAttachDeliveryPrBinding(row!)).toBe(false)
  const metadata = await metadataOf(id)
  expect(metadata.codeHost.changeRequest).toBeUndefined()
})

test('pure matcher: repository identity, branch, base branch, and bound PR decide the outcome', () => {
  const base = {
    completionMode: 'pr-merge',
    integration: 'github',
    repository: 'owner/repo',
    number: 7,
    headBranch: 'work/x',
    baseBranch: 'main',
  }
  const streamMetadata = {
    codeHost: { integration: 'github', repository: 'Owner/Repo' },
    git: { branch: 'work/x', baseBranch: 'main' },
  }
  expect(evaluateDeliveryPrBinding({ ...base, metadata: streamMetadata })).toEqual({ kind: 'attach' })
  expect(
    evaluateDeliveryPrBinding({
      ...base,
      metadata: { ...streamMetadata, codeHost: { ...streamMetadata.codeHost, changeRequest: { number: 7 } } },
    })
  ).toEqual({ kind: 'bound' })
  expect(
    evaluateDeliveryPrBinding({
      ...base,
      metadata: { ...streamMetadata, codeHost: { ...streamMetadata.codeHost, changeRequest: { number: 8 } } },
    })
  ).toEqual({ kind: 'conflict', boundNumber: 8 })
  // Repository identity includes the legacy github.repo shape.
  expect(
    evaluateDeliveryPrBinding({ ...base, metadata: { github: { repo: 'owner/repo' }, git: streamMetadata.git } })
  ).toEqual({ kind: 'attach' })
  // Wrong repository, wrong branch, mismatched base, unknown identity, or a non-PR mode never match.
  expect(
    evaluateDeliveryPrBinding({
      ...base,
      metadata: { ...streamMetadata, codeHost: { integration: 'github', repository: 'other/repo' } },
    })
  ).toEqual({ kind: 'unmatched' })
  // A fact from another provider never binds a GitHub stream, even with the same repository name.
  expect(
    evaluateDeliveryPrBinding({
      ...base,
      integration: 'gitlab',
      metadata: { ...streamMetadata, codeHost: { integration: 'gitlab', repository: 'owner/repo' } },
    })
  ).toEqual({ kind: 'attach' })
  expect(evaluateDeliveryPrBinding({ ...base, integration: 'gitlab', metadata: streamMetadata })).toEqual({
    kind: 'unmatched',
  })
  expect(
    evaluateDeliveryPrBinding({
      ...base,
      metadata: { ...streamMetadata, git: { branch: 'work/y', baseBranch: 'main' } },
    })
  ).toEqual({ kind: 'unmatched' })
  expect(evaluateDeliveryPrBinding({ ...base, baseBranch: 'release', metadata: streamMetadata })).toEqual({
    kind: 'unmatched',
  })
  expect(evaluateDeliveryPrBinding({ ...base, metadata: { git: streamMetadata.git } })).toEqual({ kind: 'unmatched' })
  expect(evaluateDeliveryPrBinding({ ...base, completionMode: 'deliverable', metadata: streamMetadata })).toEqual({
    kind: 'unmatched',
  })
  expect(evaluateDeliveryPrBinding({ ...base, completionMode: 'pr-auto-merge', metadata: streamMetadata })).toEqual({
    kind: 'attach',
  })
})

test('pure plan: exactly one attachable candidate binds; every other mix records ambiguity', () => {
  expect(planDeliveryPrBinding([{ id: 'a', decision: { kind: 'attach' } }])).toEqual({
    action: 'attach',
    attachTo: 'a',
    ambiguousOn: [],
  })
  expect(planDeliveryPrBinding([{ id: 'a', decision: { kind: 'bound' } }])).toEqual({
    action: 'none',
    ambiguousOn: [],
  })
  expect(planDeliveryPrBinding([])).toEqual({ action: 'none', ambiguousOn: [] })
  expect(
    planDeliveryPrBinding([
      { id: 'a', decision: { kind: 'attach' } },
      { id: 'b', decision: { kind: 'attach' } },
    ])
  ).toEqual({ action: 'record-ambiguity', ambiguousOn: ['a', 'b'], reason: 'multiple-candidates' })
  expect(
    planDeliveryPrBinding([
      { id: 'a', decision: { kind: 'attach' } },
      { id: 'b', decision: { kind: 'bound' } },
    ])
  ).toEqual({ action: 'record-ambiguity', ambiguousOn: ['a'], reason: 'different-binding' })
  expect(planDeliveryPrBinding([{ id: 'a', decision: { kind: 'conflict', boundNumber: 1 } }])).toEqual({
    action: 'record-ambiguity',
    ambiguousOn: ['a'],
    reason: 'different-binding',
  })
  expect(
    planDeliveryPrBinding([
      { id: 'a', decision: { kind: 'conflict', boundNumber: 1 } },
      { id: 'b', decision: { kind: 'attach' } },
    ])
  ).toMatchObject({
    action: 'record-ambiguity',
    ambiguousOn: expect.arrayContaining(['a', 'b']),
    reason: 'multiple-candidates',
  })
})

test('only opened, edited, and synchronize facts drive binding; closed facts do not', () => {
  const fact = (action: string) =>
    ({
      output: 'pull_request.updated',
      version: 1,
      eventKey: randomUUID(),
      resourceKey: `${repo}#1`,
      occurredAt: new Date().toISOString(),
      data: { repository: repo, pullRequest: { number: 1 }, action, headBranch: branch },
      subject: '',
      body: '',
    }) as const
  expect(deliveryPrBindingEvent(fact('opened'))?.number).toBe(1)
  expect(deliveryPrBindingEvent(fact('edited'))).not.toBeNull()
  expect(deliveryPrBindingEvent(fact('synchronize'))).not.toBeNull()
  expect(deliveryPrBindingEvent(fact('closed'))).toBeNull()
  expect(deliveryPrBindingEvent(fact('reopened'))).toBeNull()
  expect(deliveryPrBindingEvent({ ...fact('opened'), output: 'pull_request.merged' })).toBeNull()
})
