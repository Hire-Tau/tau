import { acquireDomHarness } from '../../test/domHarness'
import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Agent, Squad, WorkStream } from '@tau/shared'
import type { ComponentProps } from 'react'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

import { SquadHomeTab } from './SquadHomeTab'
import { WorkStreamList } from './WorkStreamList'

const dependencies = {
  SquadAgentThreads: () => (
    <div className="flex flex-col md:flex-row gap-3 md:gap-4 h-full w-full min-w-0" data-agent-type-section="manager">
      Manager fixture threads
    </div>
  ),
}

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

const managerAgent = {
  id: 'manager-1',
  agentTypeId: 'manager',
  status: 'idle',
  metadata: { name: 'Manager Alpha' },
  createdAt: now,
} as Agent

function workStream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Clean active work streams card',
    description: 'Remove the nested active heading.',
    status: 'active',
    derivedState: 'in_progress',
    assigneeAgentId: null,
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

function renderSquadHome(workStreams: WorkStream[], manager?: Agent, agents: Agent[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <SquadHomeTab
          squad={squad}
          workStreams={workStreams}
          managerAgent={manager}
          agents={agents}
          dependencies={dependencies}
        />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('SquadHomeTab', () => {
  test('wires the Home active explorer behavior', () => {
    let captured: ComponentProps<typeof WorkStreamList> | undefined
    const CaptureWorkStreams = (props: ComponentProps<typeof WorkStreamList>) => {
      captured = props
      return null
    }

    renderSquadHome([workStream()], undefined, [])
    renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <SquadHomeTab
            squad={squad}
            workStreams={[workStream()]}
            dependencies={{ ...dependencies, WorkStreamList: CaptureWorkStreams }}
          />
        </QueryClientProvider>
      </MemoryRouter>
    )

    expect(captured).toMatchObject({
      activeOnly: true,
      compact: true,
      expandable: true,
      activeCollapsible: true,
    })
  })

  test('renders one reusable active work streams section without a nested custom header', () => {
    const html = renderSquadHome([workStream()])

    expect(html).toContain('>Active</span>')
    expect(html).toContain('Clean active work streams card')
    expect(html.match(/>Active<\/span>/g)).toHaveLength(1)
    expect(html).not.toContain('Active Work Streams (1)')
  })

  test('offers new consultant chats and a dedicated manager destination before active work', () => {
    const html = renderSquadHome([workStream()], managerAgent, [managerAgent])
    expect(html).toContain('href="/squads/squad-1/agents?newConsultant=1"')
    expect(html).toContain('href="/squads/squad-1/agents?agent=manager-1"')
    expect(html).toContain('Manager (Manager Alpha)')
    expect(html.indexOf('Start with a conversation')).toBeLessThan(html.indexOf('Clean active work streams card'))
    expect(html).not.toContain('data-agent-type-section="manager"')
  })

  test('keeps the manager entry available before its record loads', () => {
    expect(renderSquadHome([])).toContain('href="/squads/squad-1/manager"')
  })

  test('shows three recent consultants by human activity and excludes archived chats and workers', () => {
    const agents = [
      ...[1, 2, 3, 4].map(
        (n) =>
          ({
            ...managerAgent,
            id: `chat-${n}`,
            agentTypeId: 'consultant',
            metadata: { purpose: `Conversation ${n}` },
            lastHumanMessageAt: new Date(`2026-01-0${n}T00:00:00Z`),
          }) as Agent
      ),
      {
        ...managerAgent,
        id: 'archived',
        agentTypeId: 'consultant',
        status: 'dormant',
        metadata: { purpose: 'Archived conversation' },
      } as Agent,
      { ...managerAgent, agentTypeId: 'engineer', metadata: { purpose: 'Worker task' } } as Agent,
    ]
    const html = renderSquadHome([], managerAgent, agents)
    expect(html).toContain('Conversation 4')
    expect(html.match(/aria-label="Agent activity: Idle"/g)).toHaveLength(4)
    expect(html).toContain('Conversation 2')
    expect(html).not.toContain('Conversation 1')
    expect(html).not.toContain('Archived conversation')
    expect(html).not.toContain('Worker task')
    expect(html.indexOf('Conversation 4')).toBeLessThan(html.indexOf('Conversation 3'))
    expect(html).toContain('href="/squads/squad-1/agents?agent=chat-4"')
  })

  test('lets the summary scroll without capping work to a small nested viewport', () => {
    const html = renderSquadHome([workStream()])
    expect(html).toContain('squad-home-layout flex h-full min-h-0 w-full flex-col gap-5 overflow-y-auto')
    expect(html).not.toContain('max-h-[200px]')
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
