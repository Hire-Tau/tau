import { expect, test } from 'bun:test'
import { createBlankWorkflow, integrationSubscriptionSchema } from '@tau/shared'
import { CodeHostingRegistry, type CodeHostingAdapter } from './registry'
import { githubCodeHostingAdapter } from '../github/code-hosting'

test('a new code hosting adapter supplies delivery evidence and events without changing the flow', async () => {
  const calls: unknown[] = []
  const adapter: CodeHostingAdapter = {
    integration: 'test-code-host',
    validateRepository: (repository) => repository === 'group/subgroup/repo',
    changeRequest: async (reference, squadId) => {
      calls.push([reference, squadId])
      return { merged: true, headBranch: 'feature', baseBranch: 'main' }
    },
    containsCommit: async (_reference, _squadId, base, commit) => base === 'main' && commit === 'a'.repeat(40),
    subscriptions: (reference) => [
      {
        id: 'code-host-merged',
        source: { integration: 'test-code-host', output: 'merge_request.merged', version: 1 },
        match: { project: { value: reference.repository }, number: { value: reference.changeRequest!.number } },
        deliver: { to: 'delivery-owner', whenInactive: 'retain' },
      },
    ],
  }
  const registry = new CodeHostingRegistry([adapter, githubCodeHostingAdapter])
  const flow = createBlankWorkflow()
  flow.completion = { mode: 'pr-merge', followChanges: true }
  const metadata = {
    codeHost: { integration: adapter.integration, repository: 'group/subgroup/repo', changeRequest: { number: 7 } },
  }
  const before = structuredClone(flow)
  const { reference, adapter: resolved } = registry.resolve(metadata)!
  expect(await resolved.changeRequest(reference, 'squad')).toEqual({
    merged: true,
    headBranch: 'feature',
    baseBranch: 'main',
  })
  expect(calls).toEqual([[reference, 'squad']])
  expect(await resolved.containsCommit(reference, 'squad', 'main', 'a'.repeat(40))).toBe(true)
  expect(
    registry.subscriptions(flow, metadata).map((item) => integrationSubscriptionSchema.parse(item).source.integration)
  ).toEqual(['test-code-host'])
  expect(
    registry.subscriptions(flow, {
      codeHost: { ...metadata.codeHost, integration: 'github', repository: 'owner/repo' },
    })
  ).toHaveLength(8)
  expect(flow).toEqual(before)
  flow.completion.changeEventsTo = { step: flow.entry }
  for (const codeHost of [
    metadata.codeHost,
    { ...metadata.codeHost, integration: 'github', repository: 'owner/repo' },
  ]) {
    const events = registry.subscriptions(flow, { codeHost })
    expect(events.length).toBeGreaterThan(0)
    expect(
      events.every(
        (event) =>
          typeof event.deliver.to === 'object' && 'step' in event.deliver.to && event.deliver.to.step === flow.entry
      )
    ).toBe(true)
    expect(events.every((event) => event.deliver.whenInactive === 'retain')).toBe(true)
  }
})

test('explicit unsupported or invalid bindings never fall back to legacy GitHub; old definitions stay opt-in', () => {
  const registry = new CodeHostingRegistry([githubCodeHostingAdapter])
  const github = { repo: 'owner/repo', pr: { number: 7 } }
  const flow = createBlankWorkflow()
  expect(registry.subscriptions(flow, { github })).toEqual([])
  flow.completion.followChanges = true
  expect(registry.subscriptions(flow, { github })).toHaveLength(8)
  for (const codeHost of [
    null,
    {},
    { integration: 'gitlab', repository: 'owner/repo', changeRequest: { number: 7 } },
  ]) {
    expect(registry.resolve({ codeHost, github })).toBeNull()
    expect(registry.subscriptions(flow, { codeHost, github })).toEqual([])
  }
  expect(registry.subscriptions(flow, { codeHost: { integration: 'github', repository: 'owner/repo' } })).toEqual([])
})
