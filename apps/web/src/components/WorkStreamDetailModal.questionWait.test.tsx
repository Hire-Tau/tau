import { afterEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, waitFor } from '@testing-library/dom'
import type { Agent, AgentQuestion, Squad, WorkStream } from '@tau/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { WorkStreamDetailModal } from './WorkStreamDetailModal'

const now = new Date('2026-01-01T00:00:00Z')
const squad: Squad = {
  id: 'squad-1',
  name: 'Ops',
  purpose: 'Run things',
  status: 'active',
  squadPresetId: null,
  defaultAgents: [],
  managerAgentId: null,
  context: null,
  isAnonymous: false,
  globalCollaborationEnabled: false,
  order: 0,
  metadata: {},
  sandboxStatus: 'none',
  createdAt: now,
  updatedAt: now,
}

const question: AgentQuestion = {
  id: 'q-1',
  agentId: 'agent-1',
  squadId: squad.id,
  ownerUserId: null,
  executionId: null,
  audienceResolution: 'unroutable',
  questionData: {
    questions: [
      {
        id: 'rpc',
        type: 'select',
        question: 'Switch the testnet RPC?',
        options: [{ value: 'wait' }, { value: 'switch' }],
      },
    ],
  },
  status: 'open',
  answer: null,
  answeredByUserId: null,
  createdAt: now.toISOString(),
  answeredAt: null,
}

function questionWorkStream(): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Health check',
    description: '',
    status: 'active',
    derivedState: 'waiting_on_answer',
    openWaits: [
      {
        id: 'wait-q',
        workStreamId: 'ws-1',
        type: 'question',
        referenceId: 'q-1',
        message: 'Switch the testnet RPC?',
        createdBy: 'agent',
        createdByAgentId: 'agent-1',
        createdByUserId: null,
        completesOnApproval: false,
        openedAt: now.toISOString(),
        closedAt: null,
        resolution: null,
        resolutionNote: null,
      },
    ],
    assigneeAgentId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'deliverable',
    createdAt: now,
    updatedAt: now,
  }
}

describe('WorkStreamDetailModal question waits', () => {
  let cleanup: (() => Promise<void>) | undefined
  const realFetch = globalThis.fetch
  afterEach(async () => {
    globalThis.fetch = realFetch
    await cleanup?.()
    cleanup = undefined
  })

  async function render(seedQuestions: AgentQuestion[] | 'forbidden') {
    const posts: Array<{ url: string; body: string }> = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    queryClient.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['workstreams:read', 'agents:read'] })
    const dom = await acquireDomHarness({
      url: 'http://localhost/work-streams/ws-1',
      beforeUnmount: async () => queryClient.cancelQueries(),
      afterUnmount: () => queryClient.clear(),
    })
    cleanup = () => dom.cleanup()
    const json = (body: unknown, status = 200) =>
      new dom.window.Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'object' && 'url' in input ? input.url : String(input)
      if (init?.method === 'POST') {
        posts.push({ url, body: String(init.body) })
        return json({ ...question, status: 'answered', answer: 'switch' })
      }
      if (url.includes('/agent-questions/by-agent/')) {
        return seedQuestions === 'forbidden' ? json({ error: 'Forbidden' }, 403) : json(seedQuestions)
      }
      // Anything else the modal fetches (metrics, run, agents) fails cleanly; it is not under test.
      return json({ error: 'not mocked' }, 404)
    }) as unknown as typeof fetch
    const rendered = dom.createRoot()
    await dom.act(async () =>
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <WorkStreamDetailModal
              workStream={questionWorkStream()}
              squadMap={new Map([[squad.id, squad]])}
              agentMap={new Map<string, Agent>()}
              onClose={() => undefined}
            />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    return { body: dom.window.document.body, posts, dom }
  }

  test('renders the open question with its answer form and posts the answer', async () => {
    const { body, posts, dom } = await render([question])
    await dom.act(async () => {
      await waitFor(() => expect(body.textContent).toContain('Switch the testnet RPC?'), { timeout: 2000 })
    })
    const submit = [...body.querySelectorAll('button')].find((b) => /Submit Answer/.test(b.textContent ?? ''))
    expect(submit).toBeDefined()
    const link = [...body.querySelectorAll('a')].find((a) => a.textContent === 'Open agent thread')
    expect(link?.getAttribute('href')).toContain('agent=agent-1')
    const option = body.querySelector('input[type="radio"][value="switch"]') as HTMLInputElement | null
    expect(option).not.toBeNull()
    await dom.act(async () => {
      fireEvent.click(option!)
    })
    await dom.act(async () => {
      fireEvent.click(submit!)
    })
    await dom.act(async () => {
      await waitFor(() => expect(posts.some((p) => p.url.includes('/agent-questions/q-1/answer'))).toBe(true), {
        timeout: 2000,
      })
    })
  })

  test('explains when the question is not visible to this user', async () => {
    const { body, dom } = await render('forbidden')
    await dom.act(async () => {
      await waitFor(() => expect(body.textContent).toContain("You can't view this agent's questions"), {
        timeout: 2000,
      })
    })
    expect([...body.querySelectorAll('button')].some((b) => /Submit Answer/.test(b.textContent ?? ''))).toBe(false)
  })
})
