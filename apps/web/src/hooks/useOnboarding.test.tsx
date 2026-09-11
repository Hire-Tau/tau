import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys, onboardingQueryKeys } from '../queryKeys'
import { useOnboarding } from './useOnboarding'
import type { OnboardingStatus } from '../api/onboarding'

/**
 * Stubs `fetch` rather than `mock.module('../api/onboarding', ...)` — that
 * module is imported (directly or via queryOptions.ts) by several onboarding
 * files, and a partial per-file mock of a shared module previously leaked
 * across test files in this bun test process (broke a `getAuthSettings`
 * import elsewhere), which is a known hazard in this repo's suite. Stubbing
 * the network boundary avoids touching the module at all.
 */
function status(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    ready: false,
    items: [
      { id: 'ai_provider', required: true, state: 'todo' },
      { id: 'first_squad', required: true, state: 'todo' },
      { id: 'invite_users', required: false, state: 'todo' },
      { id: 'github', required: false, state: 'todo' },
      { id: 'chat_channel', required: false, state: 'todo' },
      { id: 'remote_hosts', required: false, state: 'todo' },
    ],
    ...overrides,
  }
}

function Probe({ onSeen }: { onSeen: (v: ReturnType<typeof useOnboarding>) => void }) {
  onSeen(useOnboarding())
  return null
}

describe('useOnboarding — synchronous gating (seeded QueryClient)', () => {
  let oldFetch: typeof globalThis.fetch
  let statusFetchCalls: number

  beforeEach(() => {
    oldFetch = globalThis.fetch
    statusFetchCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/onboarding/status')) {
        statusFetchCalls++
        return Response.json(status())
      }
      return Response.json({})
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = oldFetch
  })

  test('reports permissions as loading (not a confirmed non-admin) when the permissions query has not resolved yet', () => {
    // No queryKeys.auth.permissions(...) seeded — the exact first-render shape
    // a brand-new admin's browser has right after PasskeyRegister navigates to
    // /onboarding, before usePermissions's query has a chance to resolve. Every
    // other fixture in this file seeds permissions up front, which is why this
    // case previously went uncovered: `isAdmin` collapsing "unresolved" into
    // "confirmed non-admin" let OnboardingPage flash its restricted-access
    // message during exactly the first-run moment this feature exists for.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    let seen!: ReturnType<typeof useOnboarding>
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Probe onSeen={(v) => (seen = v)} />
      </QueryClientProvider>
    )

    expect(seen.isPermissionsLoading).toBe(true)
    expect(seen.isAdmin).toBe(false)
    expect(seen.status).toBeUndefined()
  })

  test('does not fire the status query for a viewer without settings:read', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: ['agents:read'] })

    let seen!: ReturnType<typeof useOnboarding>
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Probe onSeen={(v) => (seen = v)} />
      </QueryClientProvider>
    )

    // enabled:false means the query never fires, deterministically — no async
    // wait needed, unlike a "hasn't resolved yet" race.
    expect(statusFetchCalls).toBe(0)
    expect(seen.isAdmin).toBe(false)
    expect(seen.status).toBeUndefined()
  })

  test('returns the cached status for a viewer holding settings:read', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: ['settings:read'] })
    queryClient.setQueryData(onboardingQueryKeys.status(), status({ ready: true }))

    let seen!: ReturnType<typeof useOnboarding>
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Probe onSeen={(v) => (seen = v)} />
      </QueryClientProvider>
    )

    expect(seen.isAdmin).toBe(true)
    expect(seen.status?.ready).toBe(true)
  })
})

describe('useOnboarding — request failure (real async resolution)', () => {
  let oldFetch: typeof globalThis.fetch
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  const activeQueryClients = new Set<QueryClient>()

  beforeEach(async () => {
    oldFetch = globalThis.fetch
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/onboarding/status')) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
      }
      // A background refetch of the seeded permissions cache is possible once
      // this test awaits a tick (default staleTime is 0) — answer it for real
      // so it can't clobber the seeded admin permission with an empty list.
      if (url.includes('/auth/permissions')) {
        return Response.json({ permissions: ['settings:read'] })
      }
      return Response.json({})
    }) as typeof fetch
    ;({ container, root } = dom.createRoot())
  })

  afterEach(async () => {
    await Promise.all([...activeQueryClients].map((client) => client.cancelQueries()))
    for (const client of activeQueryClients) client.clear()
    activeQueryClients.clear()
    await dom.cleanup()
    globalThis.fetch = oldFetch
  })

  test('a failed status request settles to status: undefined, never a thrown error — no banner on a broken instance', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    activeQueryClients.add(queryClient)
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: ['settings:read'] })

    let seen!: ReturnType<typeof useOnboarding>
    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe onSeen={(v) => (seen = v)} />
        </QueryClientProvider>
      )
    })
    // Let the rejected queryFn's promise settle into the query's error state.
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(seen.isAdmin).toBe(true)
    expect(seen.status).toBeUndefined()
  })
})

/**
 * The polling contract. Completing an item happens on OTHER pages (settings,
 * the squad modal, an OAuth tab). PRIMARY invalidation is now event-driven
 * (core emits `onboarding.updated`, QueryInvalidator subscribes to the
 * `onboarding` WS topic and invalidates immediately) — this poll is fallback
 * rot-insurance for an emit point nobody wired up, which is why it now runs
 * every 60s rather than the old 10s stopgap.
 *
 * Asserts the REAL query the hook registers (read back off the QueryClient's
 * cache), not a re-implementation of the predicate: a test that restates the
 * logic it is checking passes even when the hook stops setting the option.
 */
describe('useOnboarding refetch policy', () => {
  test('polls while onboarding is unfinished and STOPS once ready', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.auth.permissions(undefined), { permissions: ['settings:read'] })

    let seen!: ReturnType<typeof useOnboarding>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Probe onSeen={(v) => (seen = v)} />
      </QueryClientProvider>
    )
    expect(seen.isAdmin).toBe(true)

    const entry = client
      .getQueryCache()
      .getAll()
      .find((q) => JSON.stringify(q.queryKey) === JSON.stringify(onboardingQueryKeys.status()))
    expect(entry).toBeDefined()

    const interval = entry!.options.refetchInterval as unknown as (q: { state: { data?: OnboardingStatus } }) => unknown
    expect(typeof interval).toBe('function')

    // Unfinished → poll (fallback rot-insurance; the event path is primary).
    expect(interval({ state: { data: status({ ready: false }) } })).toBe(60_000)
    // Finished → the interval turns ITSELF off. An always-on interval would
    // have every tenant re-deriving this endpoint for the life of the tab.
    expect(interval({ state: { data: status({ ready: true }) } })).toBe(false)
    // No data yet (loading or failed) must not start an interval either.
    expect(interval({ state: {} })).toBe(false)
  })
})
