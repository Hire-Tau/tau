import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { integrationQueryKeys } from '../queryKeys'

let window: any
let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
let container: HTMLDivElement
let root: import('react-dom/client').Root
let requests: Array<{ url: string; method: string; body: string }>
let oldFetch: typeof fetch
beforeEach(async () => {
  domHarness = await acquireDomHarness({ url: 'http://localhost' })
  window = domHarness.window
  ;({ root, container } = domHarness.createRoot())
  requests = []
  oldFetch = fetch
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return Response.json({ state: 'enabled', connectionId: 'connection-1', consentedAt: '2026-01-01', revokedAt: null })
  }) as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = oldFetch
  await domHarness?.cleanup()
  domHarness = undefined
})
async function render(status: unknown, canExport = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  client.setQueryData(integrationQueryKeys.export('agent-1'), status)
  const { ExternalExportControl } = await import('./ExternalExportControl')
  await domHarness!.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ExternalExportControl agentId="agent-1" connectionId="connection-1" canExport={canExport} />
      </QueryClientProvider>
    )
  )
}

describe('ExternalExportControl', () => {
  test('is default-off and requires explicit confirmation before prospective opt-in', async () => {
    await render({ state: 'disabled' })
    expect(container.textContent).toContain('Disabled by default')
    const button = container.querySelector('button')!
    expect(button.disabled).toBe(true)
    expect(requests).toHaveLength(0)
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await domHarness!.act(async () => {
      fireEvent.click(checkbox)
      await Promise.resolve()
    })
    expect(button.disabled).toBe(false)
    await domHarness!.act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(requests.find((request) => request.method === 'POST')?.body).toContain('"consent":true')
  })

  test('shows active destination behavior and revokes without promising remote deletion', async () => {
    await render({ state: 'enabled', connectionId: 'connection-1', consentedAt: '2026-01-01', revokedAt: null })
    expect(container.textContent).toContain('does not delete remote data')
    await domHarness!.act(async () => {
      container.querySelector('button')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(requests.some((request) => request.method === 'DELETE')).toBe(true)
  })

  test('renders nothing without export permission', async () => {
    await render({ state: 'disabled' }, false)
    expect(container.innerHTML).toBe('')
  })
})
