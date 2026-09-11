import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireDomHarness } from '../../test/domHarness'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { UsersSection } from './UsersSection'
import { formatSeatPrice, inviteCostLine, nextSeatIsBilled, seatRate, seatUsageLine } from './seatPricing'
import type { SeatPricing, UserListEntry } from '../../api/users'

/**
 * A pricing payload as the server builds it — billedSeats always derived by the
 * platform's own rule unless a test deliberately pins it, so no case here can
 * accidentally assert against seat maths the server would never send.
 */
function pricing(overrides: Partial<SeatPricing> = {}): SeatPricing {
  const merged = { userCount: 2, includedSeats: 1, seatPriceCents: 1000, currency: 'USD', ...overrides }
  return { billedSeats: Math.max(0, merged.userCount - merged.includedSeats), ...merged }
}

function user(id: string): UserListEntry {
  return {
    id,
    email: `${id}@example.com`,
    displayName: null,
    disabledAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    hasPasskey: true,
    passkeyCount: 1,
    inviteExpiresAt: null,
  }
}

describe('formatSeatPrice', () => {
  test('a whole-dollar price drops the cents', () => {
    expect(formatSeatPrice(1000, 'USD')).toBe('$10')
    expect(formatSeatPrice(0, 'USD')).toBe('$0')
  })

  test('a part-dollar price keeps them', () => {
    expect(formatSeatPrice(1050, 'USD')).toBe('$10.50')
    expect(formatSeatPrice(999, 'USD')).toBe('$9.99')
  })

  test('an unknown currency degrades instead of throwing', () => {
    // A price label must never be able to white-screen the settings page.
    expect(formatSeatPrice(1000, 'not-a-currency')).toBe('10.00 not-a-currency')
  })

  test('seatRate is the monthly per-seat rate', () => {
    expect(seatRate(pricing())).toBe('$10/month')
  })
})

describe('seatUsageLine', () => {
  test('one user on a one-included-seat plan bills nothing yet', () => {
    expect(seatUsageLine(pricing({ userCount: 1 }))).toBe(
      '1 user · 0 billed seats (the first seat is included) · $10/month per billed seat'
    )
  })

  test('two users bill one seat — the off-by-one that would misstate a bill', () => {
    expect(seatUsageLine(pricing({ userCount: 2 }))).toBe(
      '2 users · 1 billed seat (the first seat is included) · $10/month per billed seat'
    )
  })

  test('N users bill N-1 seats', () => {
    expect(seatUsageLine(pricing({ userCount: 7 }))).toBe(
      '7 users · 6 billed seats (the first seat is included) · $10/month per billed seat'
    )
  })

  test('a plan including several seats says so in the plural', () => {
    expect(seatUsageLine(pricing({ userCount: 5, includedSeats: 3 }))).toBe(
      '5 users · 2 billed seats (the first 3 seats are included) · $10/month per billed seat'
    )
  })

  test('a plan including no seats drops the clause entirely', () => {
    expect(seatUsageLine(pricing({ userCount: 2, includedSeats: 0 }))).toBe(
      '2 users · 2 billed seats · $10/month per billed seat'
    )
  })
})

describe('inviteCostLine', () => {
  test('the first invite on a one-user instance is the one that starts costing money', () => {
    expect(inviteCostLine(pricing({ userCount: 1 }))).toBe(
      'This is the first invite that adds to your bill: sending it increases your subscription by $10/month.'
    )
  })

  test('a later invite is one more seat on top of the seats already billed', () => {
    expect(inviteCostLine(pricing({ userCount: 2 }))).toBe(
      'Sending this invite increases your subscription by $10/month, on top of the 1 seat you are billed for today.'
    )
    expect(inviteCostLine(pricing({ userCount: 4 }))).toContain('on top of the 3 seats you are billed for today')
  })

  test('an invite still inside the included seats costs nothing, and says so', () => {
    expect(inviteCostLine(pricing({ userCount: 1, includedSeats: 3 }))).toBe(
      'Your plan includes 3 seats and 1 is in use, so this invite adds nothing to your subscription.'
    )
    expect(inviteCostLine(pricing({ userCount: 2, includedSeats: 3 }))).toContain('2 are in use')
  })

  test('nextSeatIsBilled flips exactly at the included-seat boundary', () => {
    expect(nextSeatIsBilled(pricing({ userCount: 0, includedSeats: 1 }))).toBe(false)
    expect(nextSeatIsBilled(pricing({ userCount: 1, includedSeats: 1 }))).toBe(true)
    expect(nextSeatIsBilled(pricing({ userCount: 2, includedSeats: 3 }))).toBe(false)
    expect(nextSeatIsBilled(pricing({ userCount: 3, includedSeats: 3 }))).toBe(true)
  })
})

function renderUsers(users: UserListEntry[], seats?: { pricing: SeatPricing | null }): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queryKeys.users.list(), users)
  queryClient.setQueryData(queryKeys.roles.list(), [])
  if (seats) queryClient.setQueryData(queries.users.seatPricing().queryKey, seats)
  const ui: ReactNode = <UsersSection />
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('the Users page pricing line', () => {
  test('a managed instance states its head count, billed seats and per-seat price', () => {
    const html = renderUsers([user('u1'), user('u2')], { pricing: pricing({ userCount: 2 }) })
    expect(html).toContain('2 users · 1 billed seat (the first seat is included) · $10/month per billed seat')
  })

  test('a one-user managed instance shows zero billed seats rather than one', () => {
    const html = renderUsers([user('u1')], { pricing: pricing({ userCount: 1 }) })
    expect(html).toContain('1 user · 0 billed seats')
  })

  test('a larger instance keeps the max(0, users - included) maths', () => {
    const html = renderUsers([user('u1'), user('u2'), user('u3')], { pricing: pricing({ userCount: 12 }) })
    expect(html).toContain('12 users · 11 billed seats')
  })

  test('a managed instance with NO pricing delivered shows no pricing at all', () => {
    const html = renderUsers([user('u1'), user('u2')], { pricing: null })
    expect(html).not.toContain('billed seat')
    expect(html).not.toContain('$')
    expect(html).not.toContain('undefined')
    // The rest of the page is untouched.
    expect(html).toContain('Manage users and their role assignments.')
    expect(html).toContain('u1@example.com')
  })

  test('a self-hosted instance (endpoint never answered) is exactly as before', () => {
    const html = renderUsers([user('u1'), user('u2')])
    expect(html).not.toContain('billed seat')
    expect(html).not.toContain('$')
    expect(html).toContain('Invite User')
  })
})

describe('the invite form pricing line', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: ReturnType<typeof dom.createRoot>['root']
  const activeQueryClients = new Set<QueryClient>()

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      configureWindow: (window) => Object.assign(window, { SyntaxError }),
    })
    ;({ container, root } = dom.createRoot())
  })

  afterEach(async () => {
    await Promise.all([...activeQueryClients].map((client) => client.cancelQueries()))
    for (const client of activeQueryClients) client.clear()
    activeQueryClients.clear()
    await dom.cleanup()
  })

  async function openInviteForm(seats?: { pricing: SeatPricing | null }) {
    const queryClient = new QueryClient({
      // Seeded data only — never let a queryFn reach the network in a unit test.
      defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
    })
    activeQueryClients.add(queryClient)
    queryClient.setQueryData(queryKeys.users.list(), [user('u1')])
    queryClient.setQueryData(queryKeys.roles.list(), [])
    if (seats) queryClient.setQueryData(queries.users.seatPricing().queryKey, seats)

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <UsersSection />
        </QueryClientProvider>
      )
    })
    const inviteButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Invite User')
    await dom.act(async () => {
      inviteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    return container.textContent ?? ''
  }

  test('states the cost at the point of decision', async () => {
    const text = await openInviteForm({ pricing: pricing({ userCount: 1 }) })
    expect(text).toContain('Send Invite')
    expect(text).toContain(
      'This is the first invite that adds to your bill: sending it increases your subscription by $10/month.'
    )
  })

  test('says nothing about money when there is no pricing to state', async () => {
    const text = await openInviteForm({ pricing: null })
    expect(text).toContain('Send Invite')
    expect(text).not.toContain('subscription')
    expect(text).not.toContain('$')
  })
})
