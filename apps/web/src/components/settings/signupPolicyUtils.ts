import type { AuthSettings } from '../../api/auth'

/**
 * The three policies the server can actually express. Derived from — and saved back
 * as — the two stored fields, exactly as `isEmailAllowed()` reads them:
 *
 *   requireInvite: false                    → anyone at all (domains are ignored)
 *   requireInvite: true,  domains: []       → only addresses that already have a user
 *                                             row, i.e. someone an admin invited
 *   requireInvite: true,  domains: [a, b]   → invited users PLUS anyone whose email
 *                                             domain is on the list
 *
 * Note the asymmetry: an existing user always passes, so "invite only" is the empty
 * case of the allowlist rather than a separate switch.
 */
export type SignupPolicyMode = 'invite' | 'domains' | 'open'

export function policyModeOf(settings: AuthSettings | undefined): SignupPolicyMode {
  if (!settings) return 'invite'
  // requireInvite:false wins outright — isEmailAllowed returns true before it ever
  // looks at the domains, so a leftover list means nothing here.
  if (!settings.requireInvite) return 'open'
  return settings.allowedDomains.length > 0 ? 'domains' : 'invite'
}

/** One domain per line; tolerate `@acme.com`, stray whitespace, casing and duplicates. */
export function parseDomains(raw: string): string[] {
  const seen = new Set<string>()
  for (const line of raw.split(/[\n,]/)) {
    const domain = line.trim().toLowerCase().replace(/^@/, '')
    if (domain) seen.add(domain)
  }
  return [...seen]
}
