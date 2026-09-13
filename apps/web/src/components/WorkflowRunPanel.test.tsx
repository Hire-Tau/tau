import { expect, spyOn, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWorkflowRun, workflowPresetSchema, type WorkStream } from '@tau/shared'
import type { WorkflowRunDetail } from '@tau/client-core'
import { acquireDomHarness } from '../test/domHarness'
import { client } from '../api/clientInstance'
import { modelTierQueryKeys, queryKeys } from '../queryKeys'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { WorkflowEditor } from './squads/WorkflowEditor'

const preset = workflowPresetSchema.parse(
  Bun.YAML.parse(await Bun.file(new URL('../../../../config/workflows/solo.yaml', import.meta.url)).text())
)
const stream = { id: 'style-stream', squadId: 'style-squad', status: 'active', agentIds: [] } as unknown as WorkStream
function run(human = false): WorkflowRunDetail {
  const definition = structuredClone(preset.definition)
  if (human)
    definition.steps[0] = {
      id: 'execute',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Approve this draft',
      output: 'Decision',

      outcomes: { approved: { next: 'finish' } },
    }
  return { workStreamId: stream.id, source: {}, state: createWorkflowRun(definition), version: 0, attemptAgents: {} }
}
async function fixture(value: WorkflowRunDetail | null, permissions: string[] = []) {
  const dom = await acquireDomHarness({ url: 'http://localhost/workflows' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(modelTierQueryKeys.list(), [{ slug: 'deep', label: 'Deep' }])
  queryClient.setQueryData(queryKeys.squads.list(), [])
  queryClient.setQueryData(queryKeys.workflows.reviewers(stream.squadId), [])
  queryClient.setQueryData(queryKeys.workflows.run(stream.id), value)
  queryClient.setQueryData(queryKeys.workflows.list(), [
    { ...preset, revision: 'revision-1', disabled: false, hasTemplate: true },
  ])
  queryClient.setQueryData(queryKeys.agentTypes.list(), [])
  queryClient.setQueryData(queryKeys.auth.permissions(stream.squadId), {
    permissions,
    identity: { type: 'user', userId: 'reviewer' },
  })
  const root = dom.createRoot()
  return {
    dom,
    queryClient,
    root,
    render: async (node = <WorkflowRunPanel stream={stream} />) =>
      dom.act(async () =>
        root.root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
          </MemoryRouter>
        )
      ),
    cleanup: async () => {
      await dom.cleanup()
      queryClient.clear()
    },
  }
}
test('legacy streams render no flow controls; queued flows label the current step without claiming it is working', async () => {
  const f = await fixture(null)
  try {
    await f.render()
    expect(f.dom.window.document.body.textContent).toBe('')
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), run())
    await f.render(<WorkflowRunPanel stream={{ ...stream, status: 'queued' }} />)
    expect(f.dom.window.document.body.textContent).toContain('Queued')
    expect(f.dom.window.document.body.textContent).not.toContain('Complete delivery')
  } finally {
    await f.cleanup()
  }
})
test('human outcomes require evidence and send the displayed version and attempt; failures retain the draft', async () => {
  const f = await fixture(run(true), ['workstreams:review'])
  const advance = spyOn(client.workflows, 'advance').mockRejectedValue(new Error('The flow changed; reload'))
  try {
    await f.render()
    const button = [...f.dom.window.document.querySelectorAll('button')].find(
      (node) => node.textContent === 'approved'
    )!
    expect(button.disabled).toBe(true)
    const input = f.dom.window.document.querySelector('textarea')!
    await f.dom.act(async () => {
      Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Approved after checking scope'
      )
      input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    })
    expect(button.disabled).toBe(false)
    await f.dom.act(async () => {
      button.click()
      await Promise.resolve()
    })
    await f.dom.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(advance).toHaveBeenCalledTimes(1)
    expect(advance.mock.calls[0]!.slice(0, 2)).toEqual([
      stream.id,
      {
        action: 'complete',
        expectedVersion: 0,
        attemptId: 1,
        outcome: 'approved',
        evidence: 'Approved after checking scope',
        resume: false,
      },
    ])
    expect(input.value).toBe('Approved after checking scope')
    expect(f.dom.window.document.body.textContent).toContain('The flow changed; reload')
  } finally {
    advance.mockRestore()
    await f.cleanup()
  }
})
test('read-only viewers can inspect human work without approval or revision controls', async () => {
  const f = await fixture(run(true))
  try {
    await f.render()
    expect(f.dom.window.document.querySelector('textarea')).toBeNull()
    expect(f.dom.window.document.body.textContent).toContain('Human approval')
    expect(f.dom.window.document.body.textContent).not.toContain('Revise flow')
  } finally {
    await f.cleanup()
  }
})
test('preset customization shows the effective participant tier instead of silently reverting to the catalog', async () => {
  const f = await fixture(null)
  try {
    await f.render(
      <WorkflowEditor
        value={{
          kind: 'preset',
          id: preset.id,
          revision: 'revision-1',
          customizations: [
            {
              op: 'put-participant',
              id: 'worker',
              participant: { ...preset.definition.participants.worker!, tier: 'deep' },
            },
          ],
        }}
        onChange={() => {}}
      />
    )
    const selects = [...f.dom.window.document.querySelectorAll('select')]
    expect(selects.some((select) => select.value === 'deep')).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('new work leaves the source unset so Core applies the configured squad default', async () => {
  const { CreateFlowWorkStream } = await import('./squads/CreateFlowWorkStream')
  const f = await fixture(null, ['workstreams:create'])
  const create = spyOn(client.workflows, 'createStream').mockResolvedValue(stream)
  try {
    await f.render(<CreateFlowWorkStream squadId={stream.squadId} />)
    await f.dom.act(async () => f.dom.window.document.querySelector('button')!.click())
    const input = f.dom.window.document.querySelector('input[required]')!
    const description = f.dom.window.document.querySelector('textarea[required]')!
    await f.dom.act(async () => {
      for (const [element, value, prototype] of [
        [input, 'Prepare report', f.dom.window.HTMLInputElement.prototype],
        [description, 'A verified report', f.dom.window.HTMLTextAreaElement.prototype],
      ] as const) {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
        element.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
      }
    })
    expect(f.dom.window.document.querySelector('select')!.value).toBe('')
    await f.dom.act(async () => {
      f.dom.window.document
        .querySelector('form')!
        .dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(create).toHaveBeenCalledWith({
      squadId: stream.squadId,
      title: 'Prepare report',
      description: 'A verified report',
    })
  } finally {
    create.mockRestore()
    await f.cleanup()
  }
})

test('review permission exposes human decisions without requiring squad editing or wait-response access', async () => {
  const f = await fixture(run(true), ['squads:update', 'workstreams:respond'])
  try {
    await f.render()
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') === null).toBe(true)
    await f.dom.act(async () => {
      f.queryClient.setQueryData(queryKeys.auth.permissions(stream.squadId), {
        permissions: ['workstreams:review'],
        identity: { type: 'user', userId: 'reviewer' },
      })
    })
    await f.render()
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') !== null).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('assigned reviewer filters restrict a nonempty list and allow reviewers when empty', async () => {
  const value = run(true)
  const step = value.state.definition.steps[0]!
  if (step.kind === 'human-approval') step.approver = 'assigned-reviewers'
  const active = value.state.attempts[0]?.step
  if (active?.kind === 'human-approval') active.approver = 'assigned-reviewers'
  const f = await fixture(value, ['workstreams:review'])
  try {
    await f.render()
    expect(f.dom.window.document.body.textContent).toContain('anyone with review permission can decide.')
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') !== null).toBe(true)
    await f.render(<WorkflowRunPanel stream={{ ...stream, assignedReviewerIds: ['someone-else'] }} />)
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') === null).toBe(true)
    await f.render(<WorkflowRunPanel stream={{ ...stream, assignedReviewerIds: ['reviewer'] }} />)
    expect(f.dom.window.document.querySelector('[aria-label="Decision and evidence"]') !== null).toBe(true)
  } finally {
    await f.cleanup()
  }
})

test('step details and attempt history link to bound agents without guessing upcoming participants', async () => {
  const value = run()
  value.attemptAgents = { '1': 'builder-agent' }
  const f = await fixture(value)
  let opened = 0
  try {
    await f.render(<WorkflowRunPanel stream={stream} onOpenAgent={() => opened++} />)
    const links = [
      ...f.dom.window.document.querySelectorAll<HTMLAnchorElement>('a[aria-label="Open execute attempt 1 agent chat"]'),
    ]
    expect(links.length).toBeGreaterThanOrEqual(2)
    expect(links.every((link) => link.getAttribute('href') === '/squads/style-squad/agents?agent=builder-agent')).toBe(
      true
    )
    await f.dom.act(async () => links[0]!.click())
    expect(opened).toBe(1)
    const noAgent = run()
    f.queryClient.setQueryData(queryKeys.workflows.run(stream.id), noAgent)
    await f.render()
    expect(f.dom.window.document.querySelector('a[aria-label*="agent chat"]')).toBeNull()
  } finally {
    await f.cleanup()
  }
})

test('an action-center wait opens the matching parallel human attempt', async () => {
  const value = run(true)
  const second = {
    ...value.state.attempts[0]!,
    id: 2,
    stepId: 'second',
    step: { ...value.state.definition.steps[0]!, id: 'second', instructions: 'Decide the second branch' },
  }
  value.state.attempts.push(second)
  value.openWaits = [
    { id: 'focused', flowAttemptId: 2, resolutionHandler: 'workflow' } as import('@tau/shared').WorkStreamWait,
  ]
  const f = await fixture(value, ['workstreams:review'])
  try {
    await f.render(<WorkflowRunPanel stream={stream} focusWaitId="focused" />)
    expect(f.dom.window.document.querySelector('select')?.value).toBe('2')
    expect(f.dom.window.document.body.textContent).toContain('Decide the second branch')
  } finally {
    await f.cleanup()
  }
})
