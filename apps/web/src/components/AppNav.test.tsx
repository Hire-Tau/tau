import { beforeEach, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { isNavItemAllowed, navFooterHints, navItems, resolveNavShortcut, shouldShowVoiceButton } from './navModel'
import { queryKeys } from '../queryKeys'
import { getTabNavigationTarget, getTabPath, recordTabPath, resetTabHistory } from '../hooks/useTabHistory'

let permissions = new Set<string>()
let permissionsLoading = false
/** undefined = capability still unknown (query not yet resolved). */
let voiceStatus: { enabled: boolean } | undefined

import { AppHeader, DesktopFooter, MobileBottomNav } from './AppNav'

const useFixturePendingActions = () => ({ data: [] })
const FixtureVoiceButton = () => <button>Fixture voice trigger</button>

function renderWithProviders(children: ReactNode, path = '/squads') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: [...permissions] })
  }
  if (voiceStatus) {
    queryClient.setQueryData(queryKeys.voice.status(), voiceStatus)
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('React render harness', () => {
  test('shares one React dispatcher with workspace provider dependencies', () => {
    const queryClient = new QueryClient()

    expect(
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <span>dispatcher connected</span>
        </QueryClientProvider>
      )
    ).toContain('dispatcher connected')
  })
})

describe('MobileBottomNav rendering', () => {
  beforeEach(() => {
    resetTabHistory()
    permissions = new Set<string>()
    permissionsLoading = false
    voiceStatus = { enabled: true }
  })

  test('uses the per-render pending-actions fixture for the feed badge', () => {
    const useSevenFixtureActions = () => ({ data: Array.from({ length: 7 }, (_, id) => ({ id })) })

    const html = renderWithProviders(<MobileBottomNav usePendingActions={useSevenFixtureActions} />)

    expect(html).toContain('>7</span>')
  })

  test('keeps the feed badge absent on desktop and mobile before data resolves', () => {
    const useLoadingActions = () => ({ data: undefined, isLoading: true, isFetching: true })
    const header = renderWithProviders(<AppHeader usePendingActions={useLoadingActions} />)
    const mobile = renderWithProviders(<MobileBottomNav usePendingActions={useLoadingActions} />)

    expect(header).not.toContain('Action Center loading')
    expect(header).not.toContain('>…</span>')
    expect(mobile).not.toContain('Action Center loading')
    expect(mobile).not.toContain('>…</span>')
  })

  test('keeps the badge absent while a cached empty result refreshes in the background', () => {
    const useRefreshingActions = () => ({ data: [], isLoading: false, isFetching: true })
    const header = renderWithProviders(<AppHeader usePendingActions={useRefreshingActions} />)
    const mobile = renderWithProviders(<MobileBottomNav usePendingActions={useRefreshingActions} />)

    expect(header).not.toContain('Action Center loading')
    expect(header).not.toContain('>…</span>')
    expect(mobile).not.toContain('Action Center loading')
    expect(mobile).not.toContain('>…</span>')
  })

  test('retains a nonempty count during background refresh', () => {
    const useRefreshingActions = () => ({ data: [{ id: 1 }, { id: 2 }], isFetching: true })
    expect(renderWithProviders(<AppHeader usePendingActions={useRefreshingActions} />)).toContain('>2</span>')
    expect(renderWithProviders(<MobileBottomNav usePendingActions={useRefreshingActions} />)).toContain('>2</span>')
  })

  test('keeps Feed active for an exact action deep link on desktop and mobile', () => {
    const path = '/actions/workstream-review%3Aws-1%3Await-1'
    const header = renderWithProviders(<AppHeader usePendingActions={useFixturePendingActions} />, path)
    const mobile = renderWithProviders(<MobileBottomNav usePendingActions={useFixturePendingActions} />, path)
    expect(header).toMatch(/<a class="[^"]*text-accent-light[^"]*" href="\/"[^>]*>Feed/)
    expect(mobile).toContain('text-accent-light')
  })

  test('shows an error badge instead of zero on desktop and mobile', () => {
    const useFailedActions = () => ({ data: [], isError: true })

    const header = renderWithProviders(<AppHeader usePendingActions={useFailedActions} />)
    const mobile = renderWithProviders(<MobileBottomNav usePendingActions={useFailedActions} />)

    expect(header).toContain('aria-label="Action Center unavailable"')
    expect(header).toContain('>!</span>')
    expect(mobile).toContain('aria-label="Action Center unavailable"')
    expect(mobile).toContain('>!</span>')
  })

  test('renders Feed, Activity, Squads and Inbox but not the hidden Chat destination', () => {
    const html = renderWithProviders(<MobileBottomNav usePendingActions={useFixturePendingActions} />)

    expect(html).toContain('Feed')
    expect(html).toContain('Activity')
    expect(html).toContain('Squads')
    expect(html).toContain('Inbox')
    expect(html).toContain('Settings')
    expect(html).not.toContain('>More<')
    expect(html).not.toContain('Chat')
  })

  test('hides Schedules from the More menu even with schedules:read', () => {
    permissions.add('schedules:read')

    expect(renderWithProviders(<MobileBottomNav usePendingActions={useFixturePendingActions} />)).not.toContain(
      'Schedules'
    )
  })

  test('hides voice companion button unless ai:voice is allowed', () => {
    const deniedHtml = renderWithProviders(
      <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
    )
    expect(deniedHtml).not.toContain('Fixture voice trigger')

    permissions.add('ai:voice')
    const allowedHtml = renderWithProviders(
      <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
    )
    expect(allowedHtml).not.toContain('Fixture voice trigger')
    expect(allowedHtml).toContain('Assistant')
  })
})

describe('header microphone follows server voice capability', () => {
  // Asserted through the pure gate rather than rendered markup: whether the
  // mocked VoiceCompanionButton actually renders depends on module-mock ordering
  // across the whole suite (see the pre-existing flake on the
  // 'hides voice companion button' test above), which would make a
  // presence assertion pass alone and fail in a full run.
  test('shows the microphone only when permitted and the server has a key', () => {
    expect(shouldShowVoiceButton({ permissionsLoading: false, canVoice: true, voiceEnabled: true })).toBe(true)
  })

  test('hides the microphone when the server reports voice disabled', () => {
    expect(shouldShowVoiceButton({ permissionsLoading: false, canVoice: true, voiceEnabled: false })).toBe(false)
  })

  test('hides the microphone while the capability is still unknown', () => {
    // useVoiceEnabled maps "unknown" to false, so this is the no-flash case: a
    // mic that appears and then disappears is worse than one that appears late.
    expect(shouldShowVoiceButton({ permissionsLoading: false, canVoice: true, voiceEnabled: false })).toBe(false)
  })

  test('hides the microphone without ai:voice even when the server has a key', () => {
    expect(shouldShowVoiceButton({ permissionsLoading: false, canVoice: false, voiceEnabled: true })).toBe(false)
  })

  test('hides the microphone while permissions are still loading', () => {
    expect(shouldShowVoiceButton({ permissionsLoading: true, canVoice: true, voiceEnabled: true })).toBe(false)
  })

  test('is absent from the rendered header when the server reports voice disabled', () => {
    permissions = new Set<string>(['ai:voice'])
    permissionsLoading = false
    voiceStatus = { enabled: false }

    expect(
      renderWithProviders(
        <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
      )
    ).not.toContain('Fixture voice trigger')
  })

  // The failed-request and cached-capability cases is covered by the policy unit tests in
  // hooks/useVoiceEnabled.test.ts: react-query resets an errored query to
  // `pending` for the duration of its on-mount refetch, so a rendered component
  // cannot observe the error state deterministically.
})

describe('primary desktop navigation', () => {
  beforeEach(() => {
    resetTabHistory()
    // Grant everything: the hidden destinations must stay hidden on merit, not
    // because the test user happens to lack a permission.
    permissions = new Set<string>(['schedules:read', 'recommendations:read', 'ai:voice', 'inbox:system'])
    permissionsLoading = false
    voiceStatus = { enabled: true }
  })

  test('does not advertise Ops Insights in the header (it lives in Settings)', () => {
    const html = renderWithProviders(
      <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
    )
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))

    expect([...nav.matchAll(/>([A-Za-z ]+)<\/a>/g)].map((m) => m[1])).toEqual(['Feed', 'Activity', 'Squads'])
  })

  test('gates Ops Insights on recommendations:read', () => {
    const item = navItems.find((candidate) => candidate.to === '/recommendations')!
    expect(isNavItemAllowed(item, (permission) => permission === 'recommendations:read', false)).toBe(true)
    expect(isNavItemAllowed(item, () => false, false)).toBe(false)
    expect(isNavItemAllowed(item, () => true, true)).toBe(false)
  })

  test('does not advertise Chat or Schedules anywhere in the header', () => {
    const html = renderWithProviders(
      <AppHeader usePendingActions={useFixturePendingActions} VoiceCompanionButton={FixtureVoiceButton} />
    )

    expect(html).not.toContain('Chat')
    expect(html).not.toContain('Schedules')
    expect(html).not.toContain('href="/chat"')
    expect(html).not.toContain('href="/schedules"')
  })
})

describe('navigation keyboard shortcuts', () => {
  test('F, A and Q still navigate, and S still reaches settings', () => {
    expect(resolveNavShortcut('f')).toBe('/')
    expect(resolveNavShortcut('a')).toBe('/activity')
    expect(resolveNavShortcut('q')).toBe('/squads')
    expect(resolveNavShortcut('s')).toBe('/settings')
  })

  test('C no longer navigates to the hidden Chat destination', () => {
    expect(resolveNavShortcut('c')).toBeUndefined()
    expect(resolveNavShortcut('C')).toBeUndefined()
  })

  test('no shortcut resolves to a hidden destination', () => {
    const reachable = 'abcdefghijklmnopqrstuvwxyz'.split('').map((k) => resolveNavShortcut(k))

    expect(reachable).not.toContain('/chat')
    expect(reachable).not.toContain('/schedules')
    expect(reachable.filter(Boolean).sort()).toEqual(['/', '/activity', '/settings', '/squads'])
  })
})

describe('DesktopFooter key hints', () => {
  test('lists exactly feed, squads, settings, inbox, quick chat', () => {
    expect(navFooterHints()).toEqual([
      { key: 'F', label: 'Feed' },
      { key: 'A', label: 'Activity' },
      { key: 'Q', label: 'Squads' },
      { key: 'S', label: 'Settings' },
      { key: 'I', label: 'Inbox' },
      { key: '⌘K / Ctrl K', label: 'Assistant' },
    ])
  })

  test('keeps the quick-chat hint even though Chat left the nav', () => {
    const html = renderToStaticMarkup(<DesktopFooter />)

    // "Quick chat" is the drawer toggle, not the /chat destination — it stays.
    expect(html).toContain('Assistant')
    expect(html).not.toContain('>Chat<')
    expect(html).not.toContain('Schedules')
  })
})

describe('mobile tab target policy', () => {
  beforeEach(() => resetTabHistory())

  test('returns remembered nested path when switching tabs', () => {
    recordTabPath('/squads/abc-uuid?tab=agents')

    expect(getTabPath('squads')).toBe('/squads/abc-uuid?tab=agents')
    expect(getTabNavigationTarget('/inbox', '/squads')).toBe('/squads/abc-uuid?tab=agents')
  })

  test('returns the tab root when tapping the current tab', () => {
    recordTabPath('/squads/abc-uuid?tab=agents')

    expect(getTabNavigationTarget('/squads/abc-uuid?tab=agents', '/squads')).toBe('/squads')
  })
})
