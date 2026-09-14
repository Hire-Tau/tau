import { expect, mock, test } from 'bun:test'
import { StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { AssistantConversationView } from './AssistantConversationView'
import type { AssistantEntry } from '@tau/shared'

async function fixture(realtime: boolean) {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const stored: AssistantEntry[] = []
  const create = mock(async () => ({})),
    history = mock(async () => ({ entries: [], tasks: [], hasMore: false }))
  const append = mock(async (_id: string, entries: AssistantEntry[]) => {
    stored.push(...entries)
    return {}
  })
  const message = mock(async () => ({ id: 'task', agentId: 'manager', delivered: true, kind: 'background' }))
  const sendText = mock(async () => {})
  const voice = {
    history: [],
    status: 'idle',
    error: null,
    isLiveAudio: false,
    sendText,
    setLiveAudio: async () => {},
    disconnect() {},
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const props = {
    id: 'conversation',
    realtime,
    compact: false,
    visible: true,
    initialMessage: { id: 'suggestion', text: 'What needs my attention?' },
    onControls() {},
    onCreated() {},
    onExpand() {},
    positionControl: null,
    dependencies: {
      api: {
        create,
        history,
        append,
        message,
        list: async () => ({ conversations: [], hasMore: false }),
        inbox: mock(async () => ({
          acquired: true,
          pending: 0,
          messages: realtime
            ? []
            : [{ id: 'reply', senderId: 'manager', senderName: 'Assistant task', content: 'The task is complete' }],
        })),
        acknowledge: mock(async () => ({})),
        release: mock(async () => ({})),
      } as any,
      useAssistant: (() => voice) as any,
    },
  }
  const { root } = dom.createRoot()
  const render = () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AssistantConversationView {...props} />
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>
    )
  return { dom, render, props, create, append, message, sendText, stored, queryClient, voice }
}
test('suggested prompts start exactly one Realtime turn without creating delegated work', async () => {
  const f = await fixture(true)
  try {
    await f.dom.act(async () => f.render())
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.sendText.mock.calls).toEqual([['What needs my attention?']])
    expect(f.message).not.toHaveBeenCalled()
    await f.dom.act(async () => f.render())
    expect(f.sendText).toHaveBeenCalledTimes(1)
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})
test('without Realtime, the same prompt and task result are saved in the same conversation', async () => {
  const f = await fixture(false)
  try {
    await f.dom.act(async () => f.render())
    expect(f.sendText).not.toHaveBeenCalled()
    expect(f.message).toHaveBeenCalledTimes(1)
    expect(f.stored.map((e) => [e.role, e.text])).toEqual([
      ['user', 'What needs my attention?'],
      ['assistant', 'The task is complete'],
    ])
    expect(f.append.mock.calls.every((call) => call[0] === 'conversation')).toBe(true)
    expect(document.body.textContent).toContain('The task is complete')
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('a clicked prompt is visible as a pending bubble before conversation creation finishes', async () => {
  const f = await fixture(true)
  let finish!: () => void
  f.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({})
      })
  )
  try {
    await f.dom.act(async () => f.render())
    const transcript = document.querySelector('[aria-label="Assistant conversation"]')!
    expect(transcript.textContent).toContain('What needs my attention?')
    expect(f.sendText).not.toHaveBeenCalled()
    await f.dom.act(async () => finish())
    expect(f.sendText).toHaveBeenCalledTimes(1)
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('sending returns immediately; waiting for replies does not disable the composer', async () => {
  const f = await fixture(false)
  f.props.dependencies.api.inbox.mockImplementation(async () => ({ acquired: true, pending: 1, messages: [] }))
  try {
    await f.dom.act(async () => f.render())
    expect(f.message).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Working in the background')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false)
    expect(f.stored.map((entry) => entry.role)).toEqual(['user'])
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('Realtime thinking remains visible before response text arrives', async () => {
  const f = await fixture(true)
  f.voice.status = 'processing'
  try {
    await f.dom.act(async () => f.render())
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Thinking')
    f.voice.status = 'idle'
    await f.dom.act(async () => f.render())
    expect(document.body.textContent).not.toContain('Thinking…')
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('connection recovery stays in Realtime and never offers a different assistant', async () => {
  const f = await fixture(true)
  const retry = mock(async () => {})
  Object.assign(f.voice, {
    status: 'error',
    error: 'Peer connection disabled',
    isReconnecting: true,
    pendingTextCount: 1,
    retryConnection: retry,
  })
  try {
    await f.dom.act(async () => f.render())
    expect(document.body.textContent).toContain('Reconnecting')
    expect(document.body.textContent).not.toContain('Continue in text')
    expect(document.body.textContent).not.toContain('Peer connection disabled')
    Object.assign(f.voice, { isReconnecting: false })
    await f.dom.act(async () => f.render())
    expect(document.body.textContent).toContain('Your message is queued')
    const button = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')!
    await f.dom.act(async () => button.click())
    expect(retry).toHaveBeenCalledTimes(1)
    expect(f.message).not.toHaveBeenCalled()
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('agent inbox updates are durable context, queued independently, and acknowledged after delivery', async () => {
  const f = await fixture(true)
  const queued: any[] = []
  Object.assign(f.voice, {
    isConnected: true,
    status: 'listening',
    enqueueMessage: (message: any) => queued.push(message),
  })
  const updates = ['one', 'two'].map((id) => ({
    id,
    senderId: `agent-${id}`,
    senderName: id,
    content: `Result ${id}`,
    replyTo: `request-${id}`,
  }))
  f.props.dependencies.api.inbox.mockImplementation(async () => ({ acquired: true, pending: 0, messages: updates }))
  try {
    await f.dom.act(async () => f.render())
    expect(queued.map((message) => message.id)).toEqual(['inbox:one', 'inbox:two'])
    expect(
      f.stored.filter((entry) => entry.role === 'tool').map((entry) => JSON.parse(entry.toolResult!).content)
    ).toEqual(['Result one', 'Result two'])
    expect(f.props.dependencies.api.acknowledge).not.toHaveBeenCalled()
    await f.dom.act(async () => queued[1].onDone())
    expect(f.props.dependencies.api.acknowledge.mock.calls[0][2]).toBe('two')
    await f.dom.act(async () => queued[0].onDone())
    expect(f.props.dependencies.api.acknowledge.mock.calls[1][2]).toBe('one')
    expect(f.sendText).toHaveBeenCalledTimes(1)
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('Realtime inbox updates are saved as a compact "Task update" tool entry, not raw content', async () => {
  const f = await fixture(true)
  const enqueueMessage = mock(() => {})
  Object.assign(f.voice, { isConnected: true, status: 'listening', enqueueMessage })
  f.props.dependencies.api.inbox.mockImplementation(async () => ({
    acquired: true,
    pending: 0,
    messages: [{ id: 'update', senderId: 'agent-1', senderName: 'Assistant task', content: 'The task is complete' }],
  }))
  try {
    await f.dom.act(async () => f.render())
    const update = f.stored.find((entry) => entry.toolName === 'assistant_inbox')!
    expect(update).toBeDefined()
    expect(update.text).toBe('Task update')
    expect(update.role).toBe('tool')
    expect(JSON.parse(update.toolResult!).content).toBe('The task is complete')
    expect(enqueueMessage.mock.calls[0]?.[0].historyEntry.text).toBe('Task update')
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('a disconnected receiver leaves inbox updates unread for its next connection', async () => {
  const f = await fixture(true)
  Object.assign(f.voice, { isConnected: false })
  try {
    await f.dom.act(async () => f.render())
    expect(f.props.dependencies.api.inbox).not.toHaveBeenCalled()
    expect(f.props.dependencies.api.acknowledge).not.toHaveBeenCalled()
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('both typed transports wait for the page draft to sync before sending a design request', async () => {
  for (const realtime of [true, false]) {
    const f = await fixture(realtime)
    let release!: () => void
    const prepare = mock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const bridge = {
      prepare,
      instructions: 'Brainstorm together',
      tools: [],
      execute: async () => ({ result: {}, followUp: 'auto' as const }),
    }
    Object.assign(f.props, { pageEditor: bridge })
    try {
      await f.dom.act(async () => f.render())
      expect(f.sendText).not.toHaveBeenCalled()
      expect(f.message).not.toHaveBeenCalled()
      // Fallback also synchronizes at delegation; subsequent calls are already ready.
      prepare.mockImplementation(async () => {})
      await f.dom.act(async () => release())
      expect(realtime ? f.sendText.mock.calls.length : f.message.mock.calls.length).toBe(1)
    } finally {
      await f.dom.cleanup()
      f.queryClient.clear()
    }
  }
})

test('editor conversations follow new messages inside the panel and respect scrolling up', async () => {
  const f = await fixture(true)
  Object.assign(f.props, {
    pageEditor: { prepare: async () => {}, instructions: '', tools: [], execute: async () => ({ result: {} }) },
  })
  try {
    await f.dom.act(async () => f.render())
    const panel = document.querySelector('[aria-label="Assistant conversation"]') as HTMLDivElement
    Object.defineProperties(panel, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    })
    Object.assign(f.voice, { history: [{ role: 'assistant', text: 'First update', final: false }] })
    await f.dom.act(async () => f.render())
    expect(panel.scrollTop).toBe(1000)
    panel.scrollTop = 100
    await f.dom.act(async () => panel.dispatchEvent(new Event('scroll')))
    Object.assign(f.voice, { history: [{ role: 'assistant', text: 'Second update', final: false }] })
    await f.dom.act(async () => f.render())
    expect(panel.scrollTop).toBe(100)
    panel.scrollTop = 700
    await f.dom.act(async () => panel.dispatchEvent(new Event('scroll')))
    Object.assign(f.voice, { history: [{ role: 'assistant', text: 'Third update', final: true }] })
    await f.dom.act(async () => f.render())
    expect(panel.scrollTop).toBe(1000)
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('a failed send shows a compact gateway error and retains the draft for retry', async () => {
  const f = await fixture(true)
  f.sendText.mockImplementation(async () => {
    throw new Error('API error: 502: <!DOCTYPE html><html>' + 'proxy details'.repeat(500) + '</html>')
  })
  try {
    await f.dom.act(async () => f.render())
    expect(document.body.textContent).toContain('Tau is temporarily unavailable (502)')
    expect(document.body.textContent).not.toContain('DOCTYPE')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('What needs my attention?')
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    f.sendText.mockImplementation(async () => {})
    await f.dom.act(async () => retry.click())
    expect(f.sendText).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('saved message receipts render an open row and preserve transcript scroll and text drafts when nested', async () => {
  const f = await fixture(true)
  const open = mock()
  const props = f.props as typeof f.props & { onOpenConversation?: typeof open }
  props.onOpenConversation = open
  const { queries } = await import('../queryOptions')
  f.queryClient.setQueryData(queries.agents.detail('manager').queryKey, {
    id: 'manager',
    squadId: 'tau',
    agentTypeId: 'manager',
    status: 'idle',
    metadata: { name: 'Morgan' },
  })
  Object.assign(f.voice, {
    history: [
      {
        id: 'sent',
        role: 'tool',
        final: true,
        text: '',
        toolName: 'delegate_task',
        toolResult: JSON.stringify({
          id: 'message',
          agentId: 'manager',
          delivered: true,
          kind: 'squad',
          squadId: 'tau',
          conversation: { agentId: 'manager', squadId: 'tau', label: 'Check schedules', kind: 'squad' },
        }),
      },
    ],
  })
  try {
    await f.dom.act(async () => f.render())
    const draft = document.querySelector<HTMLTextAreaElement>('[aria-label="Message Assistant"]')!
    await f.dom.act(async () => {
      Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        draft,
        'Keep this draft'
      )
      draft.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    })
    const transcript = document.querySelector<HTMLElement>('[aria-label="Assistant conversation"]')!
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 400 },
    })
    await f.dom.act(async () => {
      transcript.scrollTop = 100
      transcript.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    const row = document.querySelector<HTMLButtonElement>('button[aria-label^="View task:"]')!
    await f.dom.act(async () => row.click())
    expect(open.mock.calls[0]?.[0]).toMatchObject({ agentId: 'manager', squadId: 'tau' })
    expect(f.message).not.toHaveBeenCalled()
    props.visible = false
    await f.dom.act(async () => f.render())
    props.visible = true
    await f.dom.act(async () => f.render())
    expect(document.querySelector('[aria-label="Message Assistant"]')).toBe(draft)
    expect(draft.value).toBe('Keep this draft')
    expect(transcript.scrollTop).toBe(100)
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})

test('legacy message receipts keep their Open conversation row', async () => {
  const f = await fixture(true)
  const open = mock()
  ;(f.props as any).onOpenConversation = open
  Object.assign(f.voice, {
    history: [
      {
        id: 'sent',
        role: 'tool',
        final: true,
        text: '',
        toolName: 'message_squad_manager',
        toolResult: JSON.stringify({ receipt: { id: 'message', agentId: 'manager' } }),
      },
    ],
  })
  try {
    await f.dom.act(async () => f.render())
    expect(document.querySelector('button[aria-label^="Open conversation:"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label^="View task:"]')).toBeNull()
  } finally {
    await f.dom.cleanup()
    f.queryClient.clear()
  }
})
