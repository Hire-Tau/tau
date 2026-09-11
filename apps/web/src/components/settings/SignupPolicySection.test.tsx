import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import { SignupPolicySection } from './SignupPolicySection'
import { parseDomains, policyModeOf } from './signupPolicyUtils'

function render(
  settings: { allowedDomains: string[]; requireInvite: boolean; defaultSignupRoleId?: string | null },
  permissions: string[]
): string {
  const qc = new QueryClient()
  qc.setQueryData(queryKeys.roles.list(), [
    { id: 'viewer-role', name: 'Viewer', permissions: ['squads:read'], appliesTo: 'user' },
    { id: 'agent-role', name: 'Internal worker', permissions: [], appliesTo: 'agent' },
  ])
  qc.setQueryData(queryKeys.auth.settings(), settings)
  qc.setQueryData(queryKeys.auth.permissions(undefined), { permissions })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SignupPolicySection />
    </QueryClientProvider>
  )
}

describe('policyModeOf mirrors isEmailAllowed', () => {
  test('invite-only is requireInvite with an empty allowlist', () => {
    expect(policyModeOf({ requireInvite: true, allowedDomains: [] })).toBe('invite')
  })

  test('a non-empty allowlist under requireInvite is domain mode', () => {
    expect(policyModeOf({ requireInvite: true, allowedDomains: ['acme.com'] })).toBe('domains')
  })

  test('requireInvite:false is open even with a leftover domain list', () => {
    // isEmailAllowed returns true before it ever reads allowedDomains.
    expect(policyModeOf({ requireInvite: false, allowedDomains: ['acme.com'] })).toBe('open')
  })
})

describe('parseDomains', () => {
  test('trims, lowercases, drops @ prefixes and dedupes', () => {
    expect(parseDomains(' @Acme.com \npartner.example\nacme.com\n\n')).toEqual(['acme.com', 'partner.example'])
  })

  test('accepts comma separation and yields nothing for blank input', () => {
    expect(parseDomains('a.com, b.com')).toEqual(['a.com', 'b.com'])
    expect(parseDomains('   \n  ')).toEqual([])
  })
})

describe('SignupPolicySection', () => {
  test.each([true, false])(
    'offers No role and human roles for self-registration (requireInvite=%s)',
    (requireInvite) => {
      const html = render({ requireInvite, allowedDomains: ['example.com'], defaultSignupRoleId: 'viewer-role' }, ['*'])
      expect(html).toContain('Default role for new accounts')
      expect(html).toContain('No role')
      expect(html.match(/<option[^>]*selected=""[^>]*>/)?.[0]).toContain('value="viewer-role"')
      expect(html).not.toContain('Internal worker')
    }
  )
  test('hides automatic grants in invite-only mode', () => {
    expect(render({ requireInvite: true, allowedDomains: [] }, ['*'])).not.toContain('Default role for new accounts')
  })
  test('shows the invite-only default as the current policy', () => {
    const html = render({ requireInvite: true, allowedDomains: [] }, ['settings:read', 'settings:write'])
    expect(html).toContain('Current policy:')
    expect(html).toContain('invite only')
    expect(html).toContain('Invite only')
    expect(html).toContain('(default)')
    // The invite radio is the checked one.
    expect(html).toContain('checked="" value="invite"')
  })

  test('renders the saved domain list in domain mode', () => {
    const html = render({ requireInvite: true, allowedDomains: ['acme.com', 'partner.example'] }, ['settings:write'])
    expect(html).toContain('checked="" value="domains"')
    expect(html).toContain('Allowed domains (one per line)')
    expect(html).toContain('acme.com')
    expect(html).toContain('partner.example')
  })

  test('shows open mode when requireInvite is false', () => {
    const html = render({ requireInvite: false, allowedDomains: [] }, ['settings:write'])
    expect(html).toContain('checked="" value="open"')
    expect(html).toContain('anyone can sign up')
  })

  test('offers the save control to settings:write operators', () => {
    const html = render({ requireInvite: true, allowedDomains: [] }, ['settings:write'])
    expect(html).toContain('Save policy')
    expect(html).not.toContain('You need the settings:write permission')
  })

  test('is read-only without settings:write', () => {
    const html = render({ requireInvite: true, allowedDomains: [] }, ['settings:read'])
    expect(html).not.toContain('Save policy')
    expect(html).toContain('You need the settings:write permission')
    // Current state is still legible to a read-only viewer.
    expect(html).toContain('invite only')
    expect(html).toContain('disabled=""')
  })
})
