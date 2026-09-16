import { expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import type { TrackedResourcesView } from '@tau/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { WorkStreamTrackedResources } from './WorkStreamTrackedResources'

type TrackedRow = TrackedResourcesView['resources'][number]

const deliveryPr: TrackedRow = {
  integration: 'github',
  repository: 'acme/api',
  kind: 'pull_request',
  number: 7,
  url: 'https://github.com/acme/api/pull/7',
  key: 'github:acme/api:pull_request:7',
  source: 'delivery',
  subscriptionIds: ['sub-delivery'],
  subscribed: true,
}
const trackedIssue: TrackedRow = {
  integration: 'github',
  repository: 'acme/api',
  kind: 'issue',
  number: 12,
  url: 'https://github.com/acme/api/issues/12',
  key: 'github:acme/api:issue:12',
  source: 'tracked',
  subscriptionIds: [],
  subscribed: false,
}
const view = (overrides: Partial<TrackedResourcesView> = {}): TrackedResourcesView => ({
  resources: [deliveryPr, trackedIssue],
  subscriptions: 'active',
  ...overrides,
})

type Call = { url: string; method: string; body?: string }

/**
 * Drives the component through the real API functions: every assertion about a
 * request (path, method, body) is an assertion about what the server receives.
 */
async function renderTracked<T>(
  options: {
    view?: TrackedResourcesView
    canUpdate?: boolean
    respond?: (call: Call, dom: Awaited<ReturnType<typeof acquireDomHarness>>) => Response | undefined
  },
  inspect: (context: {
    dom: Awaited<ReturnType<typeof acquireDomHarness>>
    calls: Call[]
    cache: QueryClient
  }) => T | Promise<T>
): Promise<T> {
  const current = options.view ?? view()
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  cache.setQueryData(queryKeys.squads.workStreamTracked('ws-1'), current)
  const dom = await acquireDomHarness({
    url: 'http://localhost/work-streams/ws-1',
    beforeUnmount: async () => cache.cancelQueries(),
    afterUnmount: () => cache.clear(),
  })
  const calls: Call[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body as string | undefined,
    }
    calls.push(call)
    const custom = options.respond?.(call, dom)
    if (custom) return custom
    return new dom.window.Response(JSON.stringify(current), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response
  }) as unknown as typeof fetch
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={cache}>
          <WorkStreamTrackedResources workStreamId="ws-1" canUpdate={options.canUpdate ?? true} />
        </QueryClientProvider>
      )
    )
    return await inspect({ dom, calls, cache })
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
}

const buttonWithLabel = (document: Document, label: string) =>
  [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label)

test('renders tracked issues and pull requests with their links, delivery badge and subscription hints', async () => {
  await renderTracked({ view: view({ subscriptions: 'not-following' }) }, ({ dom }) => {
    const { document } = dom.window
    const text = document.body.textContent ?? ''
    expect(text).toContain('Tracked issues and PRs')
    expect(text).toContain('acme/api#7')
    expect(text).toContain('acme/api#12')
    const links = [...document.querySelectorAll('a')]
    const pr = links.find((link) => link.getAttribute('href') === 'https://github.com/acme/api/pull/7')
    const issue = links.find((link) => link.getAttribute('href') === 'https://github.com/acme/api/issues/12')
    expect(pr).toBeDefined()
    expect(issue).toBeDefined()
    expect(pr!.getAttribute('target')).toBe('_blank')
    expect(pr!.getAttribute('rel')).toBe('noopener noreferrer')
    expect(issue!.getAttribute('target')).toBe('_blank')
    // The delivery change request is labelled and cannot be untracked here.
    expect(text).toContain('delivery')
    expect(buttonWithLabel(document, 'Stop tracking acme/api#7')).toBeUndefined()
    expect(buttonWithLabel(document, 'Stop tracking acme/api#12')).toBeDefined()
    // Per-resource subscription state, plus one sentence for the whole stream.
    expect(text).toContain('not subscribed')
    expect(text).toContain('This workflow does not follow code-host changes')
    // Reference material never appears in this section.
    expect(text).not.toContain('sources')
  })
})

test('hides every update affordance and shows the empty state without workstreams:update', async () => {
  await renderTracked({ view: view({ resources: [] }), canUpdate: false }, ({ dom }) => {
    const { document } = dom.window
    expect(document.body.textContent).toContain('Nothing tracked')
    expect(document.querySelector('input')).toBeNull()
    expect(document.querySelector('button')).toBeNull()
  })
  await renderTracked({ canUpdate: false }, ({ dom }) => {
    expect(dom.window.document.body.textContent).not.toContain('Nothing tracked')
    expect(buttonWithLabel(dom.window.document, 'Stop tracking acme/api#12')).toBeUndefined()
    expect(dom.window.document.querySelector('input')).toBeNull()
  })
})

test('untracks a resource by identity and refreshes the list', async () => {
  await renderTracked({}, async ({ dom, calls }) => {
    await dom.act(async () => buttonWithLabel(dom.window.document, 'Stop tracking acme/api#12')!.click())
    const remove = calls.find((call) => call.method === 'DELETE')
    expect(remove).toBeDefined()
    expect(remove!.url).toContain('/api/workstreams/ws-1/tracked')
    expect(JSON.parse(remove!.body!)).toEqual({
      resource: { integration: 'github', repository: 'acme/api', kind: 'issue', number: 12 },
    })
    await waitFor(() => expect(calls.some((call) => call.method === 'GET')).toBe(true))
  })
})

test('adds a link by URL and surfaces the API error inline', async () => {
  await renderTracked(
    {
      respond: (call, dom) =>
        call.method === 'POST' && (call.body ?? '').includes('nope')
          ? (new dom.window.Response(JSON.stringify({ error: 'Link is not a supported issue or pull request URL' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }) as unknown as Response)
          : undefined,
    },
    async ({ dom, calls }) => {
      const { document } = dom.window
      const input = document.querySelector<HTMLInputElement>(
        'input[placeholder="https://github.com/owner/repo/issues/12"]'
      )!
      const setValue = async (value: string) =>
        dom.act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
      const submit = () =>
        dom.act(async () =>
          [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add')!.click()
        )

      await setValue('https://github.com/acme/api/issues/99')
      await submit()
      const post = calls.find((call) => call.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.url).toContain('/api/workstreams/ws-1/tracked')
      expect(JSON.parse(post!.body!)).toEqual({ url: 'https://github.com/acme/api/issues/99' })
      await waitFor(() => expect(calls.some((call) => call.method === 'GET')).toBe(true))

      await setValue('nope')
      await submit()
      await waitFor(() =>
        expect(document.body.textContent).toContain('Link is not a supported issue or pull request URL')
      )
    }
  )
})
