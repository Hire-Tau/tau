import { expect, test } from 'bun:test'
import { CodeHostingRegistry, type CodeHostingAdapter } from '../integrations/code-hosting/registry'
import * as delivery from './worktree-cleanup-delivery'
const head = 'a'.repeat(40)
const metadata = {
  git: { repository: '/workspace/repo', branch: 'feature', baseBranch: 'main', remote: 'origin' },
  codeHost: { integration: 'github', repository: 'example/repo', changeRequest: { number: 42 } },
}

function fixture(
  overrides: {
    merged?: boolean
    headSha?: string
    remoteHead?: string
    remote?: string
    contains?: boolean
    baseBranch?: string
    headBranch?: string
  } = {}
) {
  const adapter: CodeHostingAdapter = {
    integration: 'github',
    validateRepository: () => true,
    changeRequest: async () => ({
      merged: overrides.merged ?? true,
      headSha: overrides.headSha ?? head,
      headBranch: overrides.headBranch ?? 'feature',
      baseBranch: overrides.baseBranch ?? 'main',
    }),
    containsCommit: async () => overrides.contains ?? true,
    subscriptions: () => [],
  }
  const calls: string[][] = []
  const exec = async (args: string[]) => {
    calls.push(args)
    if (args.includes('get-url')) return overrides.remote ?? 'git@github.com:example/repo.git\n'
    if (args.includes('ls-remote')) return `${overrides.remoteHead ?? head}\t${args.at(-1)}\n`
    throw new Error('Unexpected command')
  }
  return { registry: new CodeHostingRegistry([adapter]), exec, calls }
}

test('merged squash delivery uses the exact recoverable PR head, not local ancestry', async () => {
  expect(delivery.verifyWorktreeCleanupDelivery).toBeDefined()
  const f = fixture()
  expect(
    await delivery.verifyWorktreeCleanupDelivery(
      { squadId: 'squad', metadata, mode: 'pr-auto-merge', deliveredHead: head, repository: '/workspace/repo' },
      f.exec,
      f.registry
    )
  ).toBe(head)
  expect(f.calls.some((args) => args.includes('refs/pull/42/head'))).toBe(true)
  expect(f.calls.some((args) => args.includes('merge-base'))).toBe(false)
})

for (const defect of [
  'unmerged',
  'changed-head',
  'unrecoverable',
  'wrong-remote',
  'missing-delivered-head',
  'wrong-base',
  'wrong-branch',
] as const) {
  test(`retains worktree when delivery is ${defect}`, async () => {
    expect(delivery.verifyWorktreeCleanupDelivery).toBeDefined()
    const f = fixture({
      merged: defect !== 'unmerged',
      baseBranch: defect === 'wrong-base' ? 'other' : 'main',
      headBranch: defect === 'wrong-branch' ? 'other' : 'feature',
      headSha: defect === 'changed-head' ? 'b'.repeat(40) : head,
      remoteHead: defect === 'unrecoverable' ? 'b'.repeat(40) : head,
      remote: defect === 'wrong-remote' ? 'git@github.com:other/repo.git' : undefined,
    })
    await expect(
      delivery.verifyWorktreeCleanupDelivery(
        {
          squadId: 'squad',
          metadata,
          mode: 'pr-merge',
          deliveredHead: defect === 'missing-delivered-head' ? null : head,
          repository: '/workspace/repo',
        },
        f.exec,
        f.registry
      )
    ).rejects.toThrow()
  })
}

test('direct merge requires both live containment and remote base availability', async () => {
  expect(delivery.verifyWorktreeCleanupDelivery).toBeDefined()
  const f = fixture()
  expect(
    await delivery.verifyWorktreeCleanupDelivery(
      { squadId: 'squad', metadata, mode: 'direct-merge', deliveredHead: head, repository: '/workspace/repo' },
      f.exec,
      f.registry
    )
  ).toBe(head)
  expect(f.calls.some((args) => args.includes('refs/heads/main'))).toBe(true)
  const missing = fixture({ contains: false })
  await expect(
    delivery.verifyWorktreeCleanupDelivery(
      { squadId: 'squad', metadata, mode: 'direct-merge', deliveredHead: head, repository: '/workspace/repo' },
      missing.exec,
      missing.registry
    )
  ).rejects.toThrow()
})
