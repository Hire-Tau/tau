import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agents, db, inbox, squads, workStreams } from '../../db'
import { InboxMessage } from '../../entities/InboxMessage'
import { settleCiNotification } from './ci-notifications'
import type { Notification } from './ci-notification-state'

let squadId: string
let agentId: string
let streamId: string
let input: Notification
beforeEach(async () => {
  const [squad] = await db
    .insert(squads)
    .values({ name: 'CI settlement fixture', purpose: 'synthetic test' })
    .returning()
  squadId = squad!.id
  const [agent] = await db.insert(agents).values({ agentTypeId: 'ci-fixture', squadId, status: 'dormant' }).returning()
  agentId = agent!.id
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: 'CI fixture', metadata: { github: { repo: 'acme/repo' } } })
    .returning()
  streamId = stream!.id
  input = {
    recipientId: agentId,
    repository: 'acme/repo',
    workflowId: '1',
    runId: '100',
    runNumber: '1',
    runAttempt: '1',
    conclusion: 'failure',
    subject: 'Synthetic CI',
    content: 'Synthetic fixture result',
  }
})
afterEach(async () => {
  await db.delete(inbox).where(eq(inbox.recipientId, agentId))
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(agents).where(eq(agents.id, agentId))
  await db.delete(squads).where(eq(squads.id, squadId))
})

test('cross-workflow concurrent duplicates have one durable winner each, surviving restart and inbox retention', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => settleCiNotification(streamId, { ...input, workflowId: String((i % 2) + 1) }))
  )
  expect(results.filter((result) => result.accepted)).toHaveLength(2)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).toHaveLength(2)
  // No in-memory dedupe cache exists. Deleting messages simulates ordinary inbox
  // retention; the independent persisted high waters must still reject replay.
  await db.delete(inbox).where(eq(inbox.recipientId, agentId))
  const restartedModulePath = `${new URL('./ci-notifications.ts', import.meta.url).href}?restart=${crypto.randomUUID()}`
  const restarted = (await import(restartedModulePath)) as { settleCiNotification: typeof settleCiNotification }
  expect((await restarted.settleCiNotification(streamId, input)).accepted).toBe(false)
  expect((await settleCiNotification(streamId, { ...input, workflowId: '2' })).accepted).toBe(false)
  expect((await settleCiNotification(streamId, { ...input, runId: '101', runNumber: '2' })).accepted).toBe(true)
  expect((await settleCiNotification(streamId, input)).accepted).toBe(false)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).toHaveLength(1)
})

test('work streams linked to one PR settle independently and terminal streams reject delivery', async () => {
  const [other] = await db
    .insert(workStreams)
    .values({ squadId, title: 'Second linked stream', metadata: { github: { repo: 'acme/repo' } } })
    .returning()
  const results = await Promise.all([settleCiNotification(streamId, input), settleCiNotification(other!.id, input)])
  expect(results.every((result) => result.accepted)).toBe(true)
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).toHaveLength(2)
  for (const status of ['done', 'canceled'] as const) {
    await db.update(workStreams).set({ status }).where(eq(workStreams.id, other!.id))
    expect((await settleCiNotification(other!.id, { ...input, runNumber: '2', runId: '101' })).accepted).toBe(false)
  }
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).toHaveLength(2)
})

test('an interrupted settlement rolls back both inbox persistence and ordering state', async () => {
  const persist = InboxMessage.persistSystemAgentOnceInTransaction
  const failure = spyOn(InboxMessage, 'persistSystemAgentOnceInTransaction').mockImplementation(async (...args) => {
    await persist.apply(InboxMessage, args)
    throw new Error('synthetic interruption after insert')
  })
  try {
    await expect(settleCiNotification(streamId, input)).rejects.toThrow('synthetic interruption')
  } finally {
    failure.mockRestore()
  }
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).toHaveLength(0)
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
  expect(stream!.metadata).toEqual({ github: { repo: 'acme/repo' } })
  expect((await settleCiNotification(streamId, input)).accepted).toBe(true)
})

test('legacy metadata and unavailable recipients do not advance a watermark or emit a message', async () => {
  await db
    .update(workStreams)
    .set({ metadata: { github: { repo: 'acme/repo', ci: { lastNotifiedRunId: '100' } } } })
    .where(eq(workStreams.id, streamId))
  expect(await settleCiNotification(streamId, input)).toMatchObject({
    accepted: false,
    reason: 'legacy state requires migration',
  })
  await db.update(agents).set({ status: 'terminated' }).where(eq(agents.id, agentId))
  expect(await settleCiNotification(streamId, input)).toMatchObject({
    accepted: false,
    reason: 'recipient unavailable',
  })
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).toHaveLength(0)
})

test('pending crew dormancy rejects delivery without consuming the workflow watermark', async () => {
  await db.update(agents).set({ pendingDormancyAt: new Date() }).where(eq(agents.id, agentId))
  expect(await settleCiNotification(streamId, input)).toMatchObject({
    accepted: false,
    reason: 'recipient unavailable',
  })
  expect(await db.select().from(inbox).where(eq(inbox.recipientId, agentId))).toHaveLength(0)
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
  expect(stream!.metadata).toEqual({ github: { repo: 'acme/repo' } })
  await db.update(agents).set({ pendingDormancyAt: null }).where(eq(agents.id, agentId))
  expect((await settleCiNotification(streamId, input)).accepted).toBe(true)
})
