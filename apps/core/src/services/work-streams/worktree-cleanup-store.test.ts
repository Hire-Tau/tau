import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  db,
  squads,
  workStreams,
  worktreeCleanupJobs,
  workStreamWorktrees,
  agents,
  agentTypes,
  executions,
} from '../../db'
import * as store from './worktree-cleanup-store'
import type { WorktreeOwnership } from './repository-setup'

let squadId: string
let streamId: string
let agentId: string
let typeId: string
const head = 'a'.repeat(40)
const ownership: WorktreeOwnership = {
  workspace: '/workspace',
  repository: '/workspace/repo',
  commonDirectory: '/workspace/repo/.git',
  gitDirectory: '/workspace/repo/.git/worktrees/feature',
  worktree: '/workspace/feature',
  directoryIdentity: '1:2',
  branch: 'feature',
}
const metadata = {
  git: { repository: ownership.repository, worktree: ownership.worktree, branch: ownership.branch },
  codeHost: { integration: 'github', repository: 'example/repo', changeRequest: { number: 1 } },
}
beforeEach(async () => {
  const [squad] = await db.insert(squads).values({ name: 'cleanup-store-fixture', purpose: 'test' }).returning()
  squadId = squad.id
  typeId = crypto.randomUUID()
  await db.insert(agentTypes).values({ id: typeId, name: 'cleanup fixture', model: 'test', systemPrompt: 'test' })
  const [agent] = await db.insert(agents).values({ agentTypeId: typeId, squadId }).returning()
  agentId = agent.id
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: 'delivered', status: 'done', autoCleanupWorktree: true, agentIds: [agentId], metadata })
    .returning()
  streamId = stream.id
  await db.insert(workStreamWorktrees).values({ workStreamId: streamId, squadId, ownership })
  await db
    .insert(worktreeCleanupJobs)
    .values({ workStreamId: streamId, deliveredHead: head, deliveryMetadata: metadata })
})
afterEach(async () => {
  await db.delete(executions).where(eq(executions.agentId, agentId))
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(agents).where(eq(agents.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
})
const claim = async () => {
  expect(store.claimWorktreeCleanup).toBeDefined()
  return store.claimWorktreeCleanup(streamId, { ownership, head, metadata })
}

test('one concurrent claim wins and durably pins an exact removal input', async () => {
  const claims = await Promise.all([claim(), claim()])
  expect(claims.filter(Boolean)).toHaveLength(1)
  const [job] = await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId))
  expect(job).toMatchObject({ status: 'removing', removalInput: claims.find(Boolean) })
})

test('associated finishing execution defers cleanup; shutdown permits the next attempt', async () => {
  const [execution] = await db.insert(executions).values({ agentId, status: 'running' }).returning()
  expect(await claim()).toBeNull()
  await db.update(executions).set({ status: 'completed' }).where(eq(executions.id, execution.id))
  expect(await claim()).not.toBeNull()
})

test('unrelated workspace execution does not block a quiescent owned worktree', async () => {
  await db.update(workStreams).set({ agentIds: [] }).where(eq(workStreams.id, streamId))
  await db.insert(executions).values({ agentId, status: 'running' })
  expect(await claim()).not.toBeNull()
})

for (const reason of ['disabled', 'reopened', 'shared', 'dependent', 'metadata-changed'] as const) {
  test(`${reason} wins before the claim and prevents removal`, async () => {
    if (reason === 'disabled')
      await db.update(workStreams).set({ autoCleanupWorktree: false }).where(eq(workStreams.id, streamId))
    if (reason === 'reopened')
      await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, streamId))
    if (reason === 'shared')
      await db
        .insert(workStreams)
        .values({ squadId, title: 'shared', metadata: { git: { worktree: '/workspace/feature/../feature' } } })
    if (reason === 'dependent')
      await db.insert(workStreams).values({ squadId, title: 'dependent', dependsOn: [streamId] })
    if (reason === 'metadata-changed')
      await db
        .update(workStreams)
        .set({ metadata: { ...metadata, git: { ...metadata.git, branch: 'different' } } })
        .where(eq(workStreams.id, streamId))
    expect(await claim()).toBeNull()
  })
}

for (const action of ['disable', 'reopen', 'unbind', 'rebind-path', 'delete'] as const) {
  test(`a claimed removal prevents ${action} from releasing or changing its resource`, async () => {
    const { WorkStream } = await import('../../entities/WorkStream')
    expect(await claim()).not.toBeNull()
    const stream = await WorkStream.mustFind(streamId)
    const mutate = () => {
      if (action === 'disable') return stream.update({ autoCleanupWorktree: false })
      if (action === 'reopen') return stream.reopen()
      if (action === 'unbind') return stream.update({ agentIds: [] })
      if (action === 'rebind-path') return stream.update({ worktree: '/workspace/different' })
      return stream.delete()
    }
    await expect(mutate()).rejects.toThrow(/cleanup|removal/i)
    expect((await WorkStream.mustFind(streamId)).status).toBe('done')
  })
}

test('associated restart sees the durable removal guard but unrelated agents do not', async () => {
  expect(store.cleanupWorktreeForAgent).toBeDefined()
  expect(await claim()).not.toBeNull()
  expect(await store.cleanupWorktreeForAgent(agentId, db)).toBe(streamId)
  const [other] = await db.insert(agents).values({ agentTypeId: typeId, squadId }).returning()
  expect(await store.cleanupWorktreeForAgent(other.id, db)).toBeNull()
})

test('reopen after successful cleanup is actionable rather than dispatching to a missing path', async () => {
  const { WorkStream } = await import('../../entities/WorkStream')
  await db
    .update(worktreeCleanupJobs)
    .set({ status: 'succeeded' })
    .where(eq(worktreeCleanupJobs.workStreamId, streamId))
  await expect((await WorkStream.mustFind(streamId)).reopen()).rejects.toThrow(/worktree|cleanup/i)
})

for (const attachment of ['path', 'dependency'] as const) {
  test(`a new ${attachment} attachment cannot race a claimed removal`, async () => {
    const { WorkStream } = await import('../../entities/WorkStream')
    expect(await claim()).not.toBeNull()
    const [other] = await db.insert(workStreams).values({ squadId, title: 'other' }).returning()
    const stream = await WorkStream.mustFind(other.id)
    await expect(
      stream.update(attachment === 'path' ? { worktree: ownership.worktree } : { dependsOn: [streamId] })
    ).rejects.toThrow(/cleanup|removal/i)
  })
}

for (const action of ['add', 'remove'] as const) {
  test(`legacy ${action} agent mutation cannot bypass the cleanup guard`, async () => {
    const { WorkStream } = await import('../../entities/WorkStream')
    expect(await claim()).not.toBeNull()
    const stream = await WorkStream.mustFind(streamId)
    const [other] = await db.insert(agents).values({ agentTypeId: typeId, squadId }).returning()
    await expect(action === 'add' ? stream.addAgent(other.id) : stream.removeAgent(agentId)).rejects.toThrow(
      /cleanup|removal/i
    )
  })
}
