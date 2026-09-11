import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import { isUserAssignableRole, type RoleSummary } from '../../api/roles'
import { acquireDomHarness } from '../../test/domHarness'

const ROLES: RoleSummary[] = [
  { id: 'r-admin', name: 'Admin', slug: 'admin', permissions: ['*'], appliesTo: 'user', isSystem: true },
  { id: 'r-operator', name: 'Operator', slug: 'operator', permissions: ['squads:*'], appliesTo: 'user' },
  { id: 'r-viewer', name: 'Viewer', slug: 'viewer', permissions: ['squads:read'], appliesTo: 'user' },
  { id: 'r-worker', name: 'Squad Worker', slug: 'default-worker', permissions: ['chat:send'], appliesTo: 'agent' },
  { id: 'r-manager', name: 'Squad Manager', slug: 'default-manager', permissions: ['chat:send'], appliesTo: 'agent' },
]

describe('isUserAssignableRole', () => {
  test('keeps user and both roles, drops agent roles', () => {
    expect(ROLES.filter(isUserAssignableRole).map((r) => r.slug)).toEqual(['admin', 'operator', 'viewer'])
    expect(isUserAssignableRole({ id: 'x', name: 'X', slug: 'x', permissions: [], appliesTo: 'both' })).toBe(true)
  })

  test('treats a role from an older server (no appliesTo) as user-assignable', () => {
    expect(isUserAssignableRole({ id: 'x', name: 'X', slug: 'x', permissions: [] })).toBe(true)
  })
})

describe('invite form role picker', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let queryClient: QueryClient | undefined
  let UsersSection: typeof import('./UsersSection').UsersSection

  beforeEach(async () => {
    dom = await acquireDomHarness({
      url: 'http://localhost/',
      beforeUnmount: async () => {
        await queryClient?.cancelQueries()
        queryClient?.clear()
      },
    })
    ;({ UsersSection } = await import('./UsersSection'))
    ;({ root, container } = dom.createRoot())
  })

  afterEach(async () => {
    await dom.cleanup()
    queryClient = undefined
  })

  async function openInviteForm(roles: RoleSummary[] = ROLES) {
    queryClient = new QueryClient({
      // Seeded data only — never let a queryFn reach the network in a unit test.
      defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
    })
    queryClient.setQueryData(queryKeys.users.list(), [
      { id: 'u1', email: 'admin@example.com', displayName: 'Admin', disabledAt: null, createdAt: '2026-01-01' },
    ])
    queryClient.setQueryData(queryKeys.roles.list(), roles)
    queryClient.setQueryData(queryKeys.users.roles('u1'), [])

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <UsersSection />
        </QueryClientProvider>
      )
    })

    const inviteButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Invite User')
    await dom.act(async () => {
      inviteButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    return container.querySelector('#invite-user-role') as HTMLSelectElement
  }

  test('the invite form has a role picker preselected to operator', async () => {
    const select = await openInviteForm()
    expect(select).not.toBeNull()
    expect(select.value).toBe('operator')
  })

  test('viewer is freely selectable', async () => {
    const select = await openInviteForm()
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(values).toContain('viewer')
    expect(values).toContain('admin')
  })

  test('agent roles never appear in the picker', async () => {
    const select = await openInviteForm()
    const values = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(values).not.toContain('default-worker')
    expect(values).not.toContain('default-manager')
    expect(select.textContent).not.toContain('Squad Worker')
  })

  test('the per-user role editor is fed the same filtered list', async () => {
    await openInviteForm()
    // Expanding a user row renders its own role <select>; nothing agent-derived
    // may reach it either.
    const manage = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Manage Roles')
    await dom.act(async () => {
      manage!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const rowSelect = container.querySelector('#assign-role-u1') as HTMLSelectElement
    expect(rowSelect).not.toBeNull()
    const values = [...rowSelect.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(values).toContain('r-viewer')
    expect(values).not.toContain('r-worker')
    expect(values).not.toContain('r-manager')
  })

  test('falls back to the first available role when operator is absent', async () => {
    const select = await openInviteForm(ROLES.filter((r) => r.slug !== 'operator'))
    // A <select> whose value matches no option would silently render the first
    // one while state still said "operator" — the payload must match the control.
    expect(select.value).toBe('admin')
  })
})
