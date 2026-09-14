import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRepository, type WorktreeOwnership } from './repository-setup'
import * as runtime from './worktree-cleanup-runtime'

let root: string
let repo: string
let ownership: WorktreeOwnership
let head: string
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
  if (code) throw new Error(err || out)
  return out
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tau-cleanup-')))
  repo = join(root, 'repo')
  await mkdir(repo)
  await exec(['git', 'init', '-b', 'main', repo])
  await writeFile(join(repo, '.gitignore'), 'evidence/\n')
  await writeFile(join(repo, 'README'), 'recoverable\n')
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
  head = (await exec(['git', '-C', repo, 'rev-parse', 'HEAD'])).trim()
  await exec(['git', '-C', repo, 'remote', 'add', 'origin', 'git@github.com:example/repo.git'])
  await prepareRepository(
    exec,
    root,
    { repository: repo, branch: 'feature', baseBranch: 'main' },
    'owned',
    {},
    (value) => {
      ownership = value
    }
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function remove(operationId = crypto.randomUUID()) {
  expect(runtime.removeOwnedWorktree).toBeDefined()
  return runtime.removeOwnedWorktree(exec, { ownership, head, operationId })
}

test('removes only the clean owned directory and preserves the branch and source checkout', async () => {
  expect(await remove()).toMatchObject({ status: 'succeeded' })
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(false)
  expect(await readFile(join(repo, 'README'), 'utf8')).toBe('recoverable\n')
  expect((await exec(['git', '-C', repo, 'rev-parse', 'feature'])).trim()).toBe(head)
})

test('replays the exact terminal receipt without deleting a replacement directory', async () => {
  const operationId = crypto.randomUUID()
  const first = await remove(operationId)
  await mkdir(ownership.worktree)
  await writeFile(join(ownership.worktree, 'evidence'), 'new data')
  expect(await remove(operationId)).toEqual(first)
  expect(await readFile(join(ownership.worktree, 'evidence'), 'utf8')).toBe('new data')
})

for (const kind of ['tracked', 'untracked', 'ignored', 'lock', 'head'] as const) {
  test(`retains ${kind} evidence or identity changes`, async () => {
    if (kind === 'tracked') await writeFile(join(ownership.worktree, 'README'), 'changed')
    if (kind === 'untracked') await writeFile(join(ownership.worktree, 'notes'), 'evidence')
    if (kind === 'ignored') {
      await mkdir(join(ownership.worktree, 'evidence'))
      await writeFile(join(ownership.worktree, 'evidence/secret'), 'retain')
    }
    if (kind === 'lock') await exec(['git', '-C', repo, 'worktree', 'lock', ownership.worktree])
    if (kind === 'head') head = 'a'.repeat(40)
    expect(await remove()).toMatchObject({ status: 'retained' })
    expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  })
}

test('recovery only reads a terminal receipt and never starts an undispatched operation', async () => {
  expect(runtime.readWorktreeRemovalReceipt).toBeDefined()
  const input = { ownership, head, operationId: crypto.randomUUID() }
  await expect(runtime.readWorktreeRemovalReceipt(exec, input)).rejects.toThrow()
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  const result = await runtime.removeOwnedWorktree(exec, input)
  expect(await runtime.readWorktreeRemovalReceipt(exec, input)).toEqual(result)
})

test('recovers a lost response through the same exact terminal receipt', async () => {
  expect(runtime.readWorktreeRemovalReceipt).toBeDefined()
  const input = { ownership, head, operationId: crypto.randomUUID() }
  await expect(
    runtime.removeOwnedWorktree(async (args) => {
      await exec(args)
      throw new Error('lost response')
    }, input)
  ).rejects.toThrow('lost response')
  expect(await runtime.readWorktreeRemovalReceipt(exec, input)).toMatchObject({
    status: 'succeeded',
    operationId: input.operationId,
  })
})
