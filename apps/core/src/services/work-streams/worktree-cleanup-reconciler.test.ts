import { beforeEach, afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, squads, workStreams, workStreamWorktrees, worktreeCleanupJobs } from '../../db'
import { WorkStream } from '../../entities/WorkStream'
import { prepareRepository, type WorktreeOwnership } from './repository-setup'
import { claimWorktreeCleanup } from './worktree-cleanup-store'
import * as reconciler from './worktree-cleanup-reconciler'
let root: string, squadId: string, streamId: string, head: string
let ownership: WorktreeOwnership
let metadata: Record<string, unknown>
const exec = async (args: string[]) => {
  const child = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Child ${code}: ${err || out}`)
  return out
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tau-cleanup-reconcile-')))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await exec(['git', 'init', '-b', 'main', repo])
  await writeFile(join(repo, 'README'), 'delivered\n')
  await exec(['git', '-C', repo, 'add', '.'])
  await exec([
    'git',
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'initial',
  ])
  await exec(['git', '-C', repo, 'remote', 'add', 'origin', 'git@github.com:example/repo.git'])
  head = (await exec(['git', '-C', repo, 'rev-parse', 'HEAD'])).trim()
  metadata = await prepareRepository(
    exec,
    root,
    { repository: repo, baseBranch: 'main', branch: 'feature' },
    'owned',
    {},
    (value) => {
      ownership = value
    }
  )
  const [squad] = await db.insert(squads).values({ name: 'cleanup-reconcile-fixture', purpose: 'test' }).returning()
  squadId = squad.id
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: 'delivered', status: 'done', autoCleanupWorktree: true, metadata })
    .returning()
  streamId = stream.id
  await db.insert(workStreamWorktrees).values({ squadId, workStreamId: streamId, ownership })
  await db
    .insert(worktreeCleanupJobs)
    .values({ workStreamId: streamId, deliveredHead: head, deliveryMetadata: metadata })
})
afterEach(async () => {
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
  await rm(root, { recursive: true, force: true })
})
const job = async () =>
  (await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, streamId)))[0]!
const deps = () => ({ execForSquad: async () => exec, verify: async () => head, notify: async () => {} })
const processJob = async (overrides = {}) => {
  expect(reconciler.processWorktreeCleanup).toBeDefined()
  return reconciler.processWorktreeCleanup(streamId, { ...deps(), ...overrides })
}

test('reconciles a durable intent into actual removal without changing delivered status or provenance', async () => {
  await processJob()
  expect((await job()).status).toBe('succeeded')
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(false)
  expect((await WorkStream.mustFind(streamId)).toJson()).toMatchObject({ status: 'done', metadata })
  await processJob()
  expect((await job()).status).toBe('succeeded')
})

test('lost remote response remains fenced and restart recovers the immutable receipt', async () => {
  await processJob({
    execForSquad: async () => async (args: string[]) => {
      const result = await exec(args)
      if (args[3] === 'tau-worktree-cleanup') throw new Error('lost response')
      return result
    },
  })
  expect((await job()).status).toBe('removing')
  await expect((await WorkStream.mustFind(streamId)).reopen()).rejects.toThrow(/cleanup|removal/i)
  await processJob()
  expect((await job()).status).toBe('succeeded')
})

test('restart redelivers the exact persisted operation after a crash before dispatch', async () => {
  const input = await claimWorktreeCleanup(streamId, { ownership, head, metadata })
  expect(input).not.toBeNull()
  await processJob()
  expect(await job()).toMatchObject({ status: 'succeeded', operationId: input!.operationId })
})

test('an interrupted active operation without terminal proof is never taken over', async () => {
  const input = await claimWorktreeCleanup(streamId, { ownership, head, metadata })
  await mkdir(join(ownership.commonDirectory, 'tau-worktree-cleanup', input!.operationId), { recursive: true })
  await processJob()
  expect((await job()).status).toBe('removing')
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
})

test('opt-out and unavailable delivery preserve the directory without dispatch', async () => {
  await db.update(workStreams).set({ autoCleanupWorktree: false }).where(eq(workStreams.id, streamId))
  await processJob({
    execForSquad: async () => {
      throw new Error('must not contact runtime')
    },
  })
  expect((await job()).status).toBe('skipped')
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
})

test('transient delivery errors back off without changing done or acquiring a removal fence', async () => {
  await processJob({
    verify: async () => {
      throw new Error('provider unavailable')
    },
  })
  expect(await job()).toMatchObject({ status: 'deferred', operationId: null })
  expect((await WorkStream.mustFind(streamId)).status).toBe('done')
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
})

test('public detail reports cleanup status without exposing private operation inputs', async () => {
  await processJob()
  const json = (await WorkStream.mustFind(streamId)).toJson()
  expect(json).toHaveProperty('worktreeCleanup.status', 'succeeded')
  expect(json.worktreeCleanup).not.toHaveProperty('removalInput')
})

test('explicit opt-in after delivery revives a skipped intent without sweeping other streams', async () => {
  await db.update(worktreeCleanupJobs).set({ status: 'skipped' }).where(eq(worktreeCleanupJobs.workStreamId, streamId))
  const stream = await WorkStream.mustFind(streamId)
  await stream.update({ autoCleanupWorktree: true })
  expect((await job()).status).toBe('pending')
})

test('terminal partial failures keep their operation fence and use capped backoff on recovery', async () => {
  const { createHash } = await import('node:crypto')
  const input = (await claimWorktreeCleanup(streamId, { ownership, head, metadata }))!
  const active = join(ownership.commonDirectory, 'tau-worktree-cleanup', input.operationId)
  await mkdir(active, { recursive: true })
  const serialized = JSON.stringify({
    head,
    operationId: input.operationId,
    ownership: Object.fromEntries(Object.entries(ownership).sort(([a], [b]) => a.localeCompare(b))),
  })
  await writeFile(
    join(active, 'receipt.json'),
    JSON.stringify({
      status: 'failed',
      reason: 'Partial removal requires inspection',
      operationId: input.operationId,
      digest: createHash('sha256').update(serialized).digest('hex'),
    })
  )
  await processJob()
  await processJob()
  expect(await job()).toMatchObject({ status: 'error', operationId: input.operationId, attempts: 3 })
  expect((await job()).nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(59_000)
  expect(reconciler.cleanupRetryDelay(100)).toBe(3_600_000)
  await expect((await WorkStream.mustFind(streamId)).update({ autoCleanupWorktree: false })).rejects.toThrow(
    /cleanup|removal/i
  )
})
