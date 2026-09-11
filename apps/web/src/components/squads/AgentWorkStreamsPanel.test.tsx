import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import type { Agent, Squad, WorkStream } from '@tau/shared'

const { AgentWorkStreamsPanel } = await import('./AgentWorkStreamsPanel')

const now = new Date('2026-01-01T00:00:00Z')

const squad: Squad = {
  id: 'squad-1',
  name: 'Tau',
  purpose: 'Build Tau',
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

const agent: Agent = {
  id: 'agent-1',
  squadId: squad.id,
  agentTypeId: 'engineer',
  status: 'idle',
  persist: false,
  metadata: { name: 'Engineer' },
  context: null,
  questionData: null,
  sessionUsage: null,
  createdAt: now,
  updatedAt: now,
  lastMessageAt: null,
  terminatedAt: null,
}

function workStream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Relevant work stream',
    description: 'A relevant work stream.',
    status: 'active',
    derivedState: 'in_progress',
    assigneeAgentId: null,
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'pr-merge',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function renderPanel(workStreams: WorkStream[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.workStreams(squad.id), workStreams)
  queryClient.setQueryData(queryKeys.squads.list(), [squad])
  queryClient.setQueryData(queryKeys.squads.agents(squad.id), [agent])

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AgentWorkStreamsPanel agent={agent} squadId={squad.id} />
    </QueryClientProvider>
  )
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

describe('AgentWorkStreamsPanel', () => {
  test('renders attached work streams in canonical scheduler order', () => {
    const attached = (overrides: Partial<WorkStream>) => workStream({ agentIds: [agent.id], ...overrides })
    const html = renderPanel([
      attached({ id: 'idle', title: 'Panel Idle', derivedState: 'idle' }),
      attached({ id: 'queue-2', title: 'Panel Queue Two', status: 'queued', queuePosition: 2 }),
      attached({ id: 'review', title: 'Panel Review', derivedState: 'in_review' }),
      attached({ id: 'wait', title: 'Panel Wait', derivedState: 'blocked' }),
      attached({ id: 'progress', title: 'Panel Progress', derivedState: 'in_progress' }),
      attached({ id: 'queue-1', title: 'Panel Queue One', status: 'queued', queuePosition: 1 }),
    ])
    const indices = [
      'Panel Review',
      'Panel Wait',
      'Panel Progress',
      'Panel Idle',
      'Panel Queue One',
      'Panel Queue Two',
    ].map((title) => html.indexOf(title))
    expect(indices.every((index) => index >= 0)).toBe(true)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  test('includes work streams created by the agent with a Creator badge', () => {
    const html = renderPanel([
      workStream({ id: 'created', title: 'Creator only work', creatorAgentId: agent.id }),
      workStream({ id: 'unrelated', title: 'Unrelated work' }),
    ])

    expect(html).toContain('Creator only work')
    expect(html).toContain('Creator')
    expect(html).not.toContain('Unrelated work')
  })

  test('shows creator badge once alongside assigned and owner badges when roles overlap', () => {
    const html = renderPanel([
      workStream({
        id: 'overlap',
        title: 'Overlap work',
        assigneeAgentId: agent.id,
        ownerAgentId: agent.id,
        creatorAgentId: agent.id,
        agentIds: [agent.id],
      }),
    ])

    expect(countOccurrences(html, 'Overlap work')).toBe(1)
    expect(countOccurrences(html, 'Assigned')).toBe(1)
    expect(countOccurrences(html, 'Owner')).toBe(1)
    expect(countOccurrences(html, 'Creator')).toBe(1)
  })
})
