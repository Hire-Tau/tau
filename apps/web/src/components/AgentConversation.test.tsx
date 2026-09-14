import { PermissionsProvider } from '../hooks/usePermissions'
import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatApiProvider } from '../api/ChatApiProvider'
// ---------------------------------------------------------------------------
// Module mocks — must be declared before any lazy imports
// ---------------------------------------------------------------------------

// Control permissions in tests
let _permissions = new Set<string>()

// Control active execution in tests (for Stop-button RBAC test)
let _activeExecution: { active: boolean; status?: string } | undefined = undefined
let _agentStatus = 'idle'
let _agentSquadId: string | undefined
let _slotWaits: Array<{ waiterId: string; poolKey: string; queuedAt: string }> = []

// Control the live sandbox-wait signal AgentChat's useAgentConversation would supply to the header
let _waitingForSandbox = false

// Mock @tanstack/react-query hooks to avoid dual-React hook issues in renderToStaticMarkup.
// AgentConversationBody calls useQueryClient/useQuery/useMutation for header chrome.
// We preserve queryOptions (used by queryOptions.ts) by re-exporting it.
// useQuery call order in AgentConversationBody: 1=agent, 2=activeExecution, 3=agentType.
let _useQueryCallCount = 0
import { ReactQueryHooksProvider } from '../reactQueryHooks'

const reactQueryOverrides = {
  useQueryClient: () => ({ invalidateQueries: () => undefined }),
  useQuery: () => {
    const call = ++_useQueryCallCount
    if (call === 2 && _activeExecution !== undefined) {
      return { data: _activeExecution }
    }
    // call 1 = agent: return a minimal agent so the header renders
    if (call === 1 && _activeExecution !== undefined) {
      return { data: { id: 'a1', status: _agentStatus, terminatedAt: null, squadId: _agentSquadId } }
    }
    if (call === 4) return { data: _slotWaits }
    return { data: undefined }
  },
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}

// Mock usePermissions so tests control agents:run
const usePermissionsMock = () => ({
  permissions: [..._permissions],
  can: (permission: string) => _permissions.has(permission),
  isLoading: false,
  isError: false,
})

// Mock AgentChat so we can assert it's rendered with the right props
const TestAgentChat = ({
  agentId,
  embedded,
  enableFullscreen,
  isReview,
  inputDisabled,
  viewingUserId,
  header,
  showRawText,
  onToggleRawText,
}: {
  agentId?: string
  embedded?: boolean
  enableFullscreen?: boolean
  isReview?: boolean
  inputDisabled?: boolean
  viewingUserId?: string
  header?: ReactNode | ((state: { waitingForSandbox: boolean }) => ReactNode)
  showRawText?: boolean
  onToggleRawText?: () => void
}) => (
  <div
    data-testid="agent-chat"
    data-agent-id={agentId ?? ''}
    data-embedded={String(embedded ?? false)}
    data-enable-fullscreen={String(enableFullscreen ?? true)}
    data-is-review={String(isReview ?? false)}
    data-input-disabled={String(inputDisabled ?? false)}
    data-viewing-user-id={viewingUserId ?? ''}
    data-show-raw-text={String(showRawText)}
    data-has-raw-text-toggle={String(typeof onToggleRawText === 'function')}
  >
    {header && (
      <div data-testid="agent-chat-header">
        {typeof header === 'function' ? header({ waitingForSandbox: _waitingForSandbox }) : header}
      </div>
    )}
  </div>
)

// ---------------------------------------------------------------------------
// Lazy import (after all mocks are established)
// ---------------------------------------------------------------------------

const { AgentConversation } = await import('./AgentConversation.tsx')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function render(props: Parameters<typeof AgentConversation>[0]) {
  _useQueryCallCount = 0
  return renderToStaticMarkup(
    <PermissionsProvider usePermissions={usePermissionsMock}>
      <ReactQueryHooksProvider hooks={reactQueryOverrides}>
        <ChatApiProvider
          overrides={{
            getAgent: async () => null as never,
            getActiveExecution: async () => ({ active: false }) as never,
          }}
        >
          <AgentConversation {...props} dependencies={{ AgentChatComponent: TestAgentChat }} />
        </ChatApiProvider>
      </ReactQueryHooksProvider>
    </PermissionsProvider>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentConversation wraps AgentChat', () => {
  test('includes queued slot context in the current conversation header alongside execution status', () => {
    _agentSquadId = 'squad-a'
    _permissions = new Set(['slots:use'])
    _activeExecution = { active: true, status: 'running' }
    _slotWaits = [{ waiterId: 'waiter-a', poolKey: 'shared-box-intensive', queuedAt: '2026-09-14T21:49:49Z' }]
    try {
      const html = render({ agentId: 'a1' })
      expect(html).toContain('Queued for slots:')
      expect(html).toContain('shared-box-intensive')
      expect(html).toContain('running')
    } finally {
      _agentSquadId = undefined
      _permissions = new Set()
      _activeExecution = undefined
      _slotWaits = []
    }
  })

  test('renders AgentChat with agentId forwarded', () => {
    const html = render({ agentId: 'my-agent' })
    expect(html).toContain('data-testid="agent-chat"')
    expect(html).toContain('data-agent-id="my-agent"')
  })

  test('forwards embedded=true to AgentChat', () => {
    const html = render({ agentId: 'a1', embedded: true })
    expect(html).toContain('data-embedded="true"')
  })

  test('forwards enableFullscreen=false to AgentChat', () => {
    const html = render({ agentId: 'a1', enableFullscreen: false })
    expect(html).toContain('data-enable-fullscreen="false"')
  })

  test('forwards isReview to AgentChat', () => {
    const html = render({ agentId: 'a1', isReview: true })
    expect(html).toContain('data-is-review="true"')
  })

  test('forwards viewingUserId to AgentChat', () => {
    const html = render({ agentId: 'a1', viewingUserId: 'user-42' })
    expect(html).toContain('data-viewing-user-id="user-42"')
  })

  test('owns rendered mode by default and forwards the raw text toggle API', () => {
    const html = render({ agentId: 'a1' })

    expect(html).toContain('data-show-raw-text="false"')
    expect(html).toContain('data-has-raw-text-toggle="true"')
  })
})

describe('AgentConversation RBAC gating (agents:run)', () => {
  test('inputDisabled=true when agents:run permission is absent', () => {
    _permissions = new Set()
    const html = render({ agentId: 'a1' })
    // usePermissions returns can('agents:run') = false → canRunAgent = false → inputDisabled={!canRunAgent} = true
    expect(html).toContain('data-input-disabled="true"')
  })

  test('inputDisabled=false when agents:run permission is granted', () => {
    _permissions = new Set(['agents:run'])
    const html = render({ agentId: 'a1' })
    expect(html).toContain('data-input-disabled="false"')
  })

  test('Stop button is disabled when agents:run permission is absent', () => {
    _permissions = new Set()
    _activeExecution = { active: true, status: 'running' }
    try {
      const html = render({ agentId: 'a1' })
      // canRunAgent=false → ConfirmButton disabled=true → <button disabled="">Stop</button>
      // The Stop button label is present (canStopExecution=true because status='running')
      expect(html).toContain('Stop')
      expect(html).toContain('disabled=""')
    } finally {
      _activeExecution = undefined
    }
  })

  test('Stop button is enabled when agents:run permission is granted', () => {
    _permissions = new Set(['agents:run'])
    _activeExecution = { active: true, status: 'running' }
    try {
      const html = render({ agentId: 'a1' })
      // canRunAgent=true → ConfirmButton disabled=false → <button> (no disabled="" HTML attr)
      expect(html).toContain('Stop')
      // Button should NOT have the disabled HTML attribute (distinct from the disabled: Tailwind class)
      // Extract the Stop button opening tag only
      const stopIdx = html.indexOf('Stop')
      const buttonStart = html.lastIndexOf('<button', stopIdx)
      const buttonTag = html.slice(buttonStart, html.indexOf('>', buttonStart) + 1)
      expect(buttonTag).not.toContain('disabled=""')
    } finally {
      _activeExecution = undefined
    }
  })
})

describe('AgentConversation status badge', () => {
  test('uses shared attention styling for compacting and resetting', () => {
    _activeExecution = { active: false }
    for (const status of ['compacting', 'resetting']) {
      _agentStatus = status
      const html = render({ agentId: 'a1' })
      expect(html).toContain('text-amber-700')
      expect(html).not.toContain('text-blue-600')
      expect(html).not.toContain('text-orange-600')
    }
    _agentStatus = 'idle'
    _activeExecution = undefined
  })
})

describe('AgentConversation execution badge (sandbox wait)', () => {
  test('labels a running execution "Waiting for sandbox" while the live stream says the turn is blocked on its sandbox', () => {
    // The DB status stays 'running' during a normal in-turn sandbox ensure; the
    // runner streams execution_phase:waiting_sandbox for exactly that window.
    _permissions = new Set(['agents:run'])
    _activeExecution = { active: true, status: 'running' }
    _waitingForSandbox = true
    try {
      const html = render({ agentId: 'a1' })
      expect(html).toContain('Waiting for sandbox')
      expect(html).not.toContain('>running<')
    } finally {
      _activeExecution = undefined
      _waitingForSandbox = false
    }
  })

  test('labels the execution "running" again once sandbox_ready clears the live signal', () => {
    _permissions = new Set(['agents:run'])
    _activeExecution = { active: true, status: 'running' }
    _waitingForSandbox = false
    try {
      const html = render({ agentId: 'a1' })
      expect(html).toContain('>running<')
      expect(html).not.toContain('Waiting for sandbox')
    } finally {
      _activeExecution = undefined
    }
  })

  test('still labels the reactive DB status waiting-sandbox as "Waiting for sandbox" without the live signal', () => {
    _permissions = new Set(['agents:run'])
    _activeExecution = { active: true, status: 'waiting-sandbox' }
    _waitingForSandbox = false
    try {
      const html = render({ agentId: 'a1' })
      expect(html).toContain('Waiting for sandbox')
    } finally {
      _activeExecution = undefined
    }
  })
})
