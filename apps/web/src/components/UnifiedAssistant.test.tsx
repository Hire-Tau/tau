import { useAssistantPageNavigation } from '../hooks/useAssistantPageNavigation'
import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { PermissionsProvider } from '../hooks/usePermissions'
import { acquireDomHarness } from '../test/domHarness'
import { integrationQueries, queries } from '../queryOptions'
import { UnifiedAssistant } from './UnifiedAssistant'
import { AppHeader } from './AppNav'

test('the assistant nav button toggles the panel like its keyboard shortcut while explicit open stays idempotent', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const [key, value] of [
    [queries.voice.status().queryKey, { enabled: false }],
    [queries.inbox.mineCount().queryKey, { count: 0 }],
    [queries.squads.list().queryKey, []],
    [queries.squads.allWorkStreams().queryKey, []],
    [queries.agents.list({ agentTypeId: 'consultant' }).queryKey, []],
    [queries.actions.pending().queryKey, []],
    [integrationQueries.catalog().queryKey, { integrations: [] }],
  ] as const)
    cache.setQueryData(key, value)
  let search = ''
  function Probe() {
    search = useLocation().search
    return null
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={['/settings?section=providers']}>
            <PermissionsProvider
              usePermissions={() => ({ can: () => false, permissions: [], isLoading: false, isError: false })}
            >
              <AppHeader usePendingActions={() => ({ data: [] })} />
              <UnifiedAssistant dependencies={{ ConversationComponent: () => <div data-conversation /> }} />
              <Probe />
            </PermissionsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    const button = document.querySelector('button[aria-label="Assistant"]') as HTMLButtonElement
    const panel = document.querySelector('[role="dialog"][aria-label="Assistant"]') as HTMLDivElement
    expect(panel.hidden).toBe(true)
    await dom.act(async () => button.click())
    expect(panel.hidden).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await dom.act(async () => window.dispatchEvent(new Event('open-tau-assistant')))
    expect(panel.hidden).toBe(false)
    await dom.act(async () => button.click())
    expect(panel.hidden).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(search).toBe('?section=providers')
    await dom.act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    )
    expect(panel.hidden).toBe(false)
    await dom.act(async () => button.click())
    expect(panel.hidden).toBe(true)
  } finally {
    await dom.cleanup()
    cache.clear()
  }
})

test('assistant-driven navigation keeps the text conversation visible on the destination page', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  cache.setQueryData(queries.voice.status().queryKey, { enabled: false })
  let location = ''
  function Conversation() {
    const navigate = useAssistantPageNavigation()
    const current = useLocation()
    location = current.pathname + current.search
    return <button onClick={() => navigate('/settings?section=workflows')}>Open workflows</button>
  }
  const { root } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={['/settings?section=providers&chat=open&assistantConversation=existing']}>
            <PermissionsProvider
              usePermissions={() => ({ can: () => false, permissions: [], isLoading: false, isError: false })}
            >
              <UnifiedAssistant dependencies={{ ConversationComponent: Conversation }} />
            </PermissionsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    const panel = document.querySelector('[role="dialog"][aria-label="Assistant"]') as HTMLElement
    expect(panel.hidden).toBe(false)
    const button = [...panel.querySelectorAll('button')].find((button) => button.textContent === 'Open workflows')!
    await dom.act(async () => button.click())
    const params = new URL(location, 'http://localhost').searchParams
    expect(params.get('section')).toBe('workflows')
    expect(params.get('assistantConversation')).toBe('existing')
    expect(params.get('chat')).toBe('open')
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('Open workflows')
  } finally {
    await dom.cleanup()
    cache.clear()
  }
})

test('assistant links keep parent and recipient drafts through Back, Escape, refresh, and live voice', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const agent = { id: 'manager', squadId: 'tau', agentTypeId: 'manager', status: 'idle', metadata: { name: 'Morgan' } }
  for (const [key, value] of [
    [queries.voice.status().queryKey, { enabled: true }],
    [queries.squads.list().queryKey, []],
    [queries.squads.allWorkStreams().queryKey, []],
    [queries.agents.list({ agentTypeId: 'consultant' }).queryKey, []],
    [queries.agents.detail('manager').queryKey, agent],
    [queries.actions.pending().queryKey, []],
    [integrationQueries.catalog().queryKey, { integrations: [] }],
  ] as const)
    cache.setQueryData(key, value)
  let search = ''
  let parentProps!: Parameters<typeof import('./AssistantConversationView').AssistantConversationView>[0]
  let chatProps: any
  function Conversation(props: typeof parentProps) {
    parentProps = props
    return (
      <div>
        <input aria-label="Assistant draft" defaultValue="Unsent assistant question" />
        <button onClick={() => props.onOpenConversation?.({ agentId: 'manager', squadId: 'tau', label: 'Morgan' })}>
          Open manager
        </button>
      </div>
    )
  }
  function Chat(props: any) {
    chatProps = props
    return <input aria-label="Manager draft" defaultValue="Unsent manager question" />
  }
  function Probe() {
    search = useLocation().search
    return null
  }
  const { root } = dom.createRoot()
  const render = (url: string, key: string) =>
    root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter key={key} initialEntries={[url]}>
          <PermissionsProvider
            usePermissions={() => ({
              can: (p) => p === 'chat:send',
              permissions: ['chat:send'],
              isLoading: false,
              isError: false,
            })}
          >
            <UnifiedAssistant dependencies={{ ConversationComponent: Conversation, ChatComponent: Chat }} />
            <Probe />
          </PermissionsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  try {
    await dom.act(async () => render('/settings?section=workflows&chat=open&assistantConversation=parent', 'initial'))
    const parentInput = document.querySelector<HTMLInputElement>('[aria-label="Assistant draft"]')!
    const open = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open manager')!.click()
    await dom.act(async () => open())
    expect(parentProps.id).toBe('parent')
    expect(parentProps.visible).toBe(false)
    expect(chatProps.agentId).toBe('manager')
    expect(chatProps.inputDisabled).toBe(false)
    const managerInput = document.querySelector<HTMLInputElement>('[aria-label="Manager draft"]')!
    expect(new URLSearchParams(search).get('section')).toBe('workflows')
    expect(new URLSearchParams(search).get('commandStack')).toContain('parent')
    await dom.act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Back to Assistant"]')!.click())
    expect(parentProps.visible).toBe(true)
    expect(document.querySelector('[aria-label="Assistant draft"]')).toBe(parentInput)
    expect(parentInput.value).toBe('Unsent assistant question')
    await dom.act(async () => open())
    expect(document.querySelector('[aria-label="Manager draft"]')).toBe(managerInput)
    expect(managerInput.value).toBe('Unsent manager question')
    const deepLink = '/settings' + search
    await dom.act(async () => render(deepLink, 'refresh'))
    expect(parentProps.id).toBe('parent')
    expect(parentProps.existing).toBe(true)
    expect(chatProps.agentId).toBe('manager')
    await dom.act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(parentProps.visible).toBe(true)
    await dom.act(async () => parentProps.onControls({ live: true, connecting: false, startVoice: async () => {} }))
    await dom.act(async () => parentProps.onExpand())
    await dom.act(async () => open())
    expect(parentProps.id).toBe('parent')
    expect(parentProps.visible).toBe(false)
    expect(parentProps.compact).toBe(false)
    expect(chatProps.inputDisabled).toBe(false)
    expect(document.body.textContent).toContain('Talking to Assistant')
    await dom.act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Back to Assistant"]')!.click())
    expect(parentProps.visible).toBe(true)
  } finally {
    await dom.cleanup()
    cache.clear()
  }
})
