import { expect, test } from 'bun:test'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { RenderItem } from '@tau/client-react'
import { PermissionsProvider } from '../hooks/usePermissions'
import { acquireDomHarness } from '../test/domHarness'
import { ChatView } from './ChatView'

const permissions = () => ({
  permissions: ['agents:write'],
  can: () => true,
  isLoading: false,
  isError: false,
})

const dependencies = {
  useImageSrcsHook: () => ({}),
  usePermissionsHook: permissions,
  useVoiceEnabledHook: () => false,
  useVoiceRecorderHook: () => ({
    state: 'idle' as const,
    elapsed: 0,
    volume: 0,
    isSupported: false,
    isHoldMode: false,
    start: () => undefined,
    stop: () => undefined,
    stopAndSend: () => undefined,
    cancel: () => undefined,
    beginPress: () => undefined,
    endPress: () => undefined,
    cancelPress: () => undefined,
    isPressing: false,
  }),
}

function chatElement(items: RenderItem[] = []) {
  return (
    <PermissionsProvider usePermissions={permissions}>
      <ChatView dependencies={dependencies} items={items} onSend={() => undefined} hideComposer enableFullscreen />
    </PermissionsProvider>
  )
}

function chatRouter(entry: string, items: RenderItem[] = []) {
  return createMemoryRouter([{ path: '/chat/:agentId', element: chatElement(items) }], {
    initialEntries: [entry],
  })
}

test('fullscreen controls update only their router search and replace history', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat/a?scope=all&fullscreen=1' })
  const router = createMemoryRouter(
    [
      {
        path: '/chat/:agentId',
        element: chatElement(),
      },
      { path: '/before', element: <div>Before</div> },
    ],
    { initialEntries: ['/before', '/chat/a?scope=all&fullscreen=1'], initialIndex: 1 }
  )
  const rendered = dom.createRoot()
  try {
    await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
    expect(router.state.location.pathname).toBe('/chat/a')
    expect(router.state.location.search).toBe('?scope=all&fullscreen=1')

    const exit = dom.window.document.querySelector('[aria-label="Exit fullscreen"]') as unknown as HTMLElement
    expect(exit).not.toBeNull()
    await dom.act(async () => exit.click())
    expect(router.state.location.search).toBe('?scope=all')

    const enter = dom.window.document.querySelector('[aria-label="Fullscreen"]') as unknown as HTMLElement
    await dom.act(async () => enter.click())
    expect(router.state.location.search).toBe('?scope=all&fullscreen=1')

    await dom.act(async () => router.navigate(-1))
    expect(router.state.location.pathname).toBe('/before')
  } finally {
    await dom.cleanup()
  }
})

test('a real rendered Link navigates its router while preserving the target search', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/chat/a' })
  const navigateItem = {
    kind: 'streaming',
    id: 'navigate-stream',
    agentId: 'a',
    status: 'complete',
    blocks: [
      {
        type: 'tool_use',
        id: 'navigate-tool',
        _done: true,
        toolCall: { toolName: 'navigate', args: JSON.stringify({ path: '/chat/b?scope=squad', prompt: true }) },
      },
    ],
  } as RenderItem
  const router = chatRouter('/chat/a', [navigateItem])
  const rendered = dom.createRoot()
  try {
    await dom.act(async () => rendered.root.render(<RouterProvider router={router} />))
    const link = dom.window.document.querySelector('a[href="/chat/b?scope=squad"]') as unknown as HTMLElement
    expect(link).not.toBeNull()
    expect(router.state.location.pathname + router.state.location.search).toBe('/chat/a')
    await dom.act(async () => link.click())
    expect(router.state.location.pathname + router.state.location.search).toBe('/chat/b?scope=squad')
  } finally {
    await dom.cleanup()
  }
})

test('fresh routers stay isolated in both creation orders', async () => {
  for (const reverse of [false, true]) {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const a = chatRouter('/chat/a?scope=A')
    const b = chatRouter('/chat/b?scope=B')
    const ordered = reverse ? [b, a] : [a, b]
    const roots = ordered.map(() => dom.createRoot())
    try {
      for (let index = 0; index < ordered.length; index++) {
        await dom.act(async () => roots[index]!.root.render(<RouterProvider router={ordered[index]!} />))
      }
      expect(a.state.location.pathname + a.state.location.search).toBe('/chat/a?scope=A')
      expect(b.state.location.pathname + b.state.location.search).toBe('/chat/b?scope=B')
      await dom.act(async () => a.navigate('/chat/a?scope=A&fullscreen=1'))
      expect(a.state.location.search).toBe('?scope=A&fullscreen=1')
      expect(b.state.location.search).toBe('?scope=B')
    } finally {
      await dom.cleanup()
    }
  }
})

test('two overlapping live ChatView roots keep URL mutations instance-local', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const a = chatRouter('/chat/a?scope=A')
  const b = chatRouter('/chat/b?scope=B')
  const rootA = dom.createRoot()
  const rootB = dom.createRoot()
  try {
    await dom.act(async () => {
      rootA.root.render(<RouterProvider router={a} />)
      rootB.root.render(<RouterProvider router={b} />)
    })
    const buttonA = rootA.container.querySelector('[aria-label="Fullscreen"]') as HTMLElement
    const buttonB = rootB.container.querySelector('[aria-label="Fullscreen"]') as HTMLElement
    expect(a.state.location.search).toBe('?scope=A')
    expect(b.state.location.search).toBe('?scope=B')
    await dom.act(async () => buttonA.click())
    expect(a.state.location.search).toBe('?scope=A&fullscreen=1')
    expect(b.state.location.search).toBe('?scope=B')
    await dom.act(async () => buttonB.click())
    expect(a.state.location.search).toBe('?scope=A&fullscreen=1')
    expect(b.state.location.search).toBe('?scope=B&fullscreen=1')
  } finally {
    await dom.cleanup()
  }
})
