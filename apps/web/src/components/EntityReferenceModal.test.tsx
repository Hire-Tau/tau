import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { EntityReferenceModal } from './EntityReferenceModal'

const id = 'fa27abb6-4c92-4cc6-aff9-a8da616346c1'

test('work stream references resolve by ID and present a closable permission/error state', async () => {
  const requests: string[] = []
  const dom = await acquireDomHarness({
    url: 'https://example.test/mounted/chat',
    configureWindow(window) {
      window.fetch = async (url) => {
        requests.push(String(url))
        return new window.Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
      }
    },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let closed = false
  try {
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <EntityReferenceModal
            reference={{ kind: 'ws', id }}
            onClose={() => {
              closed = true
            }}
          />
        </QueryClientProvider>
      )
    )
    await dom.act(async () => {
      await new Promise<void>((resolve) => {
        const ready = () => dom.window.document.body.textContent?.includes('could not be opened')
        if (ready()) return resolve()
        const observer = new dom.window.MutationObserver(() => {
          if (ready()) {
            observer.disconnect()
            resolve()
          }
        })
        observer.observe(dom.window.document.body, { childList: true, subtree: true, characterData: true })
      })
    })
    expect(requests.some((url) => url.endsWith(`/api/workstreams/${id}`))).toBe(true)
    expect(dom.window.location.pathname).toBe('/mounted/chat')
    const close = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    expect(close).not.toBeNull()
    await dom.act(async () => close.click())
    expect(closed).toBe(true)
  } finally {
    await dom.cleanup()
    client.clear()
  }
})
