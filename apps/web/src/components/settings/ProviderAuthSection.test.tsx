import { describe, expect, spyOn, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  extractOAuthCode,
  formatRetryIn,
  healthReasonLabel,
  isCredentialHealthReason,
  invalidateProviderRoutingQueries,
  providerActivityRank,
  selectableProviders,
} from './providerAuthUtils'
import { AddAccountChooser, AddProviderSection, ProviderAccountsList, ProviderRow } from './ProviderAuthSection'
import type { ProviderAccountEntry } from '../../api/providerAuth'
import { acquireDomHarness } from '../../test/domHarness'

describe('extractOAuthCode', () => {
  test('extracts code from a pasted redirect URL query string', () => {
    expect(extractOAuthCode('http://localhost:1455/callback?code=abc123&state=xyz')).toBe('abc123')
  })

  test('preserves raw authorization codes', () => {
    expect(extractOAuthCode('abc123')).toBe('abc123')
  })

  test('decodes URL-encoded authorization code values', () => {
    expect(extractOAuthCode('http://localhost:1455/callback?state=xyz&code=abc%23def%2Bghi')).toBe('abc#def+ghi')
  })

  test('extracts OpenAI Codex localhost callback code', () => {
    expect(
      extractOAuthCode(
        'http://localhost:1455/auth/callback?code=ac_qnORAPg05CZNgkLMts8z3zsk-8c727nUNKHREgR2iZU.qqnNwK740EWR3bHvckUtLWzAVnNqfFwpKA6TppYNrJA&scope=openid+profile+email+offline_access&state=0d21a1acdee3f5a3c7663918c4a7dc87'
      )
    ).toBe('ac_qnORAPg05CZNgkLMts8z3zsk-8c727nUNKHREgR2iZU.qqnNwK740EWR3bHvckUtLWzAVnNqfFwpKA6TppYNrJA')
  })
})

describe('selectableProviders', () => {
  const catalog = [
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'zai', label: 'Z.ai' },
    { id: 'openrouter', label: 'OpenRouter' },
  ]

  test('excludes hidden (first-class + configured) providers', () => {
    const result = selectableProviders(catalog, new Set(['anthropic', 'openrouter']))
    expect(result.map((p) => p.id)).toEqual(['zai'])
  })

  test('returns all when nothing hidden', () => {
    expect(selectableProviders(catalog, new Set()).map((p) => p.id)).toEqual(['anthropic', 'zai', 'openrouter'])
  })
})

describe('providerActivityRank', () => {
  test('puts providers with enabled accounts first', () => {
    expect(
      providerActivityRank([
        {
          provider: 'anthropic',
          type: 'api_key',
          hasCredential: true,
          configured: true,
          disabled: false,
          accounts: [{ id: 'enabled', enabled: true, type: 'api_key' }],
        },
      ])
    ).toBe(0)
  })

  test('puts providers with only disabled accounts after active providers', () => {
    expect(
      providerActivityRank([
        {
          provider: 'anthropic',
          type: 'api_key',
          hasCredential: true,
          configured: false,
          disabled: false,
          accounts: [{ id: 'disabled', enabled: false, type: 'api_key' }],
        },
      ])
    ).toBe(1)
  })

  test('puts providers with no accounts last', () => {
    expect(providerActivityRank([undefined])).toBe(2)
  })
})

const providerReg = { id: 'anthropic', name: 'Anthropic', description: 'Claude models' }
const oauthProviderReg = {
  id: 'openai',
  name: 'OpenAI',
  description: 'GPT and o-series models',
  oauthId: 'openai-codex',
  oauthLabel: 'ChatGPT Plus/Pro',
}

function renderRow(
  entry: any,
  opts: { provider?: typeof providerReg | typeof oauthProviderReg; oauthAvailable?: boolean } = {}
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ProviderRow
        provider={opts.provider ?? providerReg}
        entry={entry}
        oauthAvailable={opts.oauthAvailable ?? false}
      />
    </QueryClientProvider>
  )
}

describe('ProviderRow status badges', () => {
  test('shows no Disabled badge for a configured, enabled provider', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
    })
    expect(html).not.toContain('Disabled')
  })

  test('shows a Disabled badge for a disabled provider', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: true,
    })
    expect(html).toContain('Disabled')
  })

  test('offers connection without repeating the outer provider heading or status', () => {
    const html = renderRow(undefined)
    expect(html).toContain('Connect account')
    expect(html).not.toContain('Not configured')
    expect(html).not.toContain(providerReg.name)
    expect(html).not.toContain(providerReg.description)
  })
})

describe('ProviderRow removed top-level button zoo', () => {
  test('does not render Set API Key / Change Key / Login with / Re-authorize buttons', () => {
    const configured = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
    })
    expect(configured).not.toContain('Set API Key')
    expect(configured).not.toContain('Change Key')

    const unconfigured = renderRow(undefined, { provider: oauthProviderReg, oauthAvailable: true })
    expect(unconfigured).not.toContain('Login with')
    expect(unconfigured).not.toContain('Re-authorize')
  })

  test('does not render per-entry (API)/(OAuth) suffixed action buttons', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
    })
    expect(html).not.toContain('Remove (API)')
    expect(html).not.toContain('Remove (OAuth)')
  })
})

describe('ProviderRow single Connect account flow', () => {
  test('renders one secondary connection action below existing accounts', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      accounts: [{ id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'available' }],
    })
    const matches = html.match(/Connect another account/g) ?? []
    expect(matches).toHaveLength(1)
  })

  test('renders a compact Connect account action for an unconfigured provider card', () => {
    const html = renderRow(undefined)
    expect(html).toContain('Connect account')
    expect(html).not.toContain('No accounts configured')
    expect(html).not.toContain('>Accounts<')
  })

  test('keeps a provider with an empty accounts array compact', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      accounts: [],
    })
    expect(html).toContain('Connect account')
    expect(html).not.toContain('>Accounts<')
  })
})

describe('AddAccountChooser', () => {
  test('renders an API key option and a Login with <label> option for an oauth-capable provider', () => {
    const html = renderToStaticMarkup(
      <AddAccountChooser
        oauthLabel="ChatGPT Plus/Pro"
        onChooseApiKey={() => {}}
        onChooseOAuth={() => {}}
        onCancel={() => {}}
      />
    )
    expect(html).toContain('API key')
    expect(html).toContain('Login with ChatGPT Plus/Pro')
  })
})

describe('AddProviderSection', () => {
  test('renders as a compact provider card with the picker in its header', () => {
    const queryClient = new QueryClient()
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <AddProviderSection
          options={[
            { id: 'zai', label: 'Z.ai', modelCount: 3, oauthAvailable: false, disabled: false },
            { id: 'together', label: 'Together', modelCount: 8, oauthAvailable: false, disabled: false },
          ]}
        />
      </QueryClientProvider>
    )

    expect(html).toContain('Add a provider')
    expect(html).toContain('another supported provider')
    expect(html).toContain('aria-label="Select a provider"')
    expect(html).toContain('Select a provider…')
    expect(html).toContain('Z.ai (3 models)')
    expect(html).toContain('Together (8 models)')
  })
})

describe('ProviderRow oauth-capable vs api-key-only providers', () => {
  // The chooser itself is gated behind add-mode state, which isn't reachable
  // via renderToStaticMarkup (no interaction). What IS render-testable without
  // interaction is that a plain, closed-state card never renders OAuth-only
  // chooser copy for a provider that has no OAuth support, and that OAuth
  // status badges only ever appear for providers that actually have an oauth
  // account configured.
  test('an API-key-only provider (no oauthAvailable) never renders "Login with" copy', () => {
    const html = renderRow(
      {
        provider: 'zai',
        type: 'api_key',
        hasCredential: true,
        configured: true,
        disabled: false,
        accounts: [{ id: 'acc_1', label: 'Key', enabled: true, type: 'api_key', health: 'available' }],
      },
      { provider: { id: 'zai', name: 'Z.ai', description: 'Z.ai models' }, oauthAvailable: false }
    )
    expect(html).not.toContain('Login with')
  })
})

describe('ProviderAccountsList', () => {
  test('renders account labels, health, and actions (no header/add-button — those live on the card)', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ProviderAccountsList
          providerId="anthropic"
          canWrite={true}
          accounts={[
            { id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'available' },
            { id: 'acc_2', label: 'Personal', enabled: false, type: 'oauth', health: 'exhausted' },
          ]}
        />
      </QueryClientProvider>
    )
    expect(html).toContain('Work')
    expect(html).toContain('Personal')
    expect(html).toContain('Available')
    expect(html).toContain('Disabled')
    expect(html).not.toContain('Connect account')
    expect(html).toContain('Account options for Work')
    expect(html).not.toContain('Delete')
  })

  test('keeps secondary account actions collapsed by default', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ProviderAccountsList
          providerId="openai-codex"
          canWrite={true}
          oauthLabel="ChatGPT Plus/Pro"
          accounts={[
            { id: 'acc_1', label: 'Work key', enabled: true, type: 'api_key', health: 'available' },
            { id: 'acc_2', label: 'Personal', enabled: true, type: 'oauth', health: 'available' },
          ]}
        />
      </QueryClientProvider>
    )
    const reloginCount = (html.match(/Re-authorize/g) ?? []).length
    expect(reloginCount).toBe(0)
  })

  function renderAccountsList(props: { canWrite?: boolean; accounts?: ProviderAccountEntry[] } = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ProviderAccountsList
          providerId="anthropic"
          canWrite={props.canWrite ?? true}
          accounts={
            props.accounts ?? [
              { id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'available' },
              { id: 'acc_2', label: 'Personal', enabled: true, type: 'oauth', health: 'available' },
            ]
          }
        />
      </QueryClientProvider>
    )
  }

  test('shows the preference-order hint and up/down move buttons when there are multiple accounts', () => {
    const html = renderAccountsList()
    expect(html).toContain('Used in order of preference; unavailable accounts fail over to the next.')
    expect(html).toContain('Move up')
    expect(html).toContain('Move down')
  })

  test('disables Move up on the first account and Move down on the last account', () => {
    const html = renderAccountsList()
    // React SSR renders the boolean `disabled` attribute as `disabled=""` only
    // when true (never for the Tailwind `disabled:` variant classes nearby).
    // Isolate each <button ...> opening tag so the check only looks at that
    // button's own attributes, not a sibling button a few characters away.
    const buttonTags = html.match(/<button[^>]*>/g) ?? []
    const moveUpTags = buttonTags.filter((tag) => tag.includes('aria-label="Move up"'))
    const moveDownTags = buttonTags.filter((tag) => tag.includes('aria-label="Move down"'))
    expect(moveUpTags).toHaveLength(2) // one per account
    expect(moveDownTags).toHaveLength(2)

    expect(moveUpTags[0]).toContain('disabled=""') // first account: Move up disabled
    expect(moveUpTags[1]).not.toContain('disabled=""') // second account: Move up enabled
    expect(moveDownTags[0]).not.toContain('disabled=""') // first account: Move down enabled
    expect(moveDownTags[1]).toContain('disabled=""') // last (second) account: Move down disabled
  })

  test('hides the hint and move buttons for a single account', () => {
    const html = renderAccountsList({
      accounts: [{ id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'available' }],
    })
    expect(html).not.toContain('Used in order of preference')
    expect(html).not.toContain('Move up')
    expect(html).not.toContain('Move down')
  })

  test('hides move buttons when canWrite is false, even with multiple accounts', () => {
    const html = renderAccountsList({ canWrite: false })
    expect(html).not.toContain('Move up')
    expect(html).not.toContain('Move down')
    // The hint is still informative for read-only viewers.
    expect(html).toContain('Used in order of preference')
  })
})

describe('ProviderRow exhaustion badge', () => {
  test('shows an Exhausted badge with retry minutes when health is exhausted', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      health: 'exhausted',
      retryAt: Date.now() + 10 * 60_000,
    })
    expect(html).toContain('Exhausted')
    expect(html).toContain('retry ~10m')
  })

  test('shows an Exhausted badge without retry time when retryAt is missing', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      health: 'exhausted',
    })
    expect(html).toContain('Exhausted')
    expect(html).not.toContain('retry ~')
  })

  test('does not show an Exhausted badge when health is available', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      health: 'available',
      retryAt: undefined,
    })
    expect(html).not.toContain('Exhausted')
  })

  test('does not show an Exhausted badge when health is unset (backwards compat)', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
    })
    expect(html).not.toContain('Exhausted')
  })
})

describe('provider credential routing invalidation', () => {
  test('refreshes derived model tiers when auth changes after the switch was enabled', async () => {
    const queryClient = new QueryClient()
    const invalidate = spyOn(queryClient, 'invalidateQueries')
    await invalidateProviderRoutingQueries(queryClient)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['providerAuth'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['model-tiers'] })
  })
})

describe('OpenRouter universal fallback section', () => {
  test('sends the real routing mutation when the Use OpenRouter switch is toggled', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const requests: { url: string; method?: string; body?: string }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method, body: init?.body as string | undefined })
      return Response.json({ enabled: true })
    }) as typeof fetch
    try {
      const [{ createRoot }, { OpenRouterSection }] = await Promise.all([
        import('react-dom/client'),
        import('./ProviderAuthSection'),
      ])
      const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await dom.act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <OpenRouterSection
              canWrite={true}
              routing={{ enabled: false, active: false, configured: true, health: 'available', vendors: [], tiers: [] }}
            />
          </QueryClientProvider>
        )
      })
      await dom.act(async () => {
        ;(container.querySelector('[role="switch"]') as HTMLInputElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(requests.find((request) => request.url.endsWith('/api/provider-auth/openrouter/routing'))).toMatchObject({
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      })
      await dom.act(async () => root.unmount())
      queryClient.clear()
    } finally {
      await dom.cleanup()
    }
  })

  test('renders explicit semantics and read-only backed vendor/tier summaries only when enabled', async () => {
    const { OpenRouterSection } = await import('./ProviderAuthSection')
    const queryClient = new QueryClient()
    const render = (enabled: boolean) =>
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <OpenRouterSection
            entry={undefined}
            canWrite={true}
            routing={{
              enabled,
              active: enabled,
              configured: false,
              health: 'available',
              vendors: ['anthropic', 'openai'],
              tiers: [{ slug: 'fast', label: 'Fast', fallbacks: ['openrouter:anthropic/claude-sonnet-5:medium'] }],
            }}
          />
        </QueryClientProvider>
      )
    const enabled = render(true)
    expect(enabled).toContain('Use OpenRouter')
    expect(enabled).toContain('Covers every model tier after direct provider accounts have been tried')
    expect(enabled).toContain('Anthropic')
    expect(enabled).toContain('Fast')
    expect(enabled).toContain('read-only')
    expect(enabled).toContain('Connect account')

    const disabled = render(false)
    expect(disabled).toContain('Use OpenRouter')
    expect(disabled).not.toContain('Backed vendors')
    expect(disabled).not.toContain('Backed tiers')
    expect(disabled).not.toContain('Connect account')
  })
})

describe('formatRetryIn', () => {
  const now = 1_000_000_000_000

  test('formats sub-minute, minute, hour and day windows', () => {
    expect(formatRetryIn(now + 45_000, now)).toBe('~45s')
    expect(formatRetryIn(now + 12 * 60_000, now)).toBe('~12m')
    expect(formatRetryIn(now + (4 * 60 + 12) * 60_000, now)).toBe('~4h 12m')
    expect(formatRetryIn(now + (2 * 24 + 3) * 60 * 60_000, now)).toBe('~2d 3h')
  })

  test('drops a zero remainder instead of printing "~4h 0m"', () => {
    expect(formatRetryIn(now + 4 * 60 * 60_000, now)).toBe('~4h')
    expect(formatRetryIn(now + 2 * 24 * 60 * 60_000, now)).toBe('~2d')
  })

  test('returns null for a missing or elapsed reset', () => {
    expect(formatRetryIn(undefined, now)).toBeNull()
    expect(formatRetryIn(now - 1, now)).toBeNull()
  })
})

describe('isCredentialHealthReason', () => {
  test('matches only the kinds that re-authorizing fixes', () => {
    expect(isCredentialHealthReason('invalid-credential')).toBe(true)
    expect(isCredentialHealthReason('expired-oauth')).toBe(true)
    expect(isCredentialHealthReason('rate-limit')).toBe(false)
    expect(isCredentialHealthReason(undefined)).toBe(false)
  })
})

describe('healthReasonLabel', () => {
  test('gives each health kind an operator-readable label', () => {
    expect(healthReasonLabel('rate-limit')).toBe('rate limit')
    expect(healthReasonLabel('plan-credit')).toBe('plan limit')
    expect(healthReasonLabel('capacity')).toBe('capacity')
    expect(healthReasonLabel('network')).toBe('connection')
    expect(healthReasonLabel('error')).toBe('error')
    expect(healthReasonLabel('invalid-credential')).toBe('invalid credential')
    expect(healthReasonLabel('expired-oauth')).toBe('expired sign-in')
    expect(healthReasonLabel(undefined)).toBeNull()
  })
})

/**
 * Exhaustion used to be announced twice — a chip strip at the top of the card
 * AND a bare "Exhausted" word on the account row — while saying neither WHY the
 * provider is out nor how long is left, and offering no way to clear a window
 * that has already reset upstream. Status now lives on the row that owns it.
 */
describe('provider exhaustion status', () => {
  const exhaustedAccount = {
    id: 'acc_1',
    label: 'Work',
    enabled: true,
    type: 'api_key' as const,
    health: 'exhausted' as const,
    healthReason: 'plan-credit' as const,
    healthMessage: 'Provider plan credit exhausted.',
    retryAt: Date.now() + 30 * 60_000,
  }

  function renderAccounts(accounts: any[], canWrite = true) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ProviderAccountsList
          providerId="anthropic"
          accounts={accounts as ProviderAccountEntry[]}
          canWrite={canWrite}
        />
      </QueryClientProvider>
    )
  }

  test('renders no top chip strip — the account row carries the status', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      health: 'exhausted',
      healthReason: 'plan-credit',
      retryAt: exhaustedAccount.retryAt,
      accounts: [exhaustedAccount],
    })
    expect(html.match(/Exhausted/g) ?? []).toHaveLength(1)
    expect(html).not.toContain('(retry ~30m)')
  })

  test('an exhausted account row states the reason and the remaining window', () => {
    const html = renderAccounts([exhaustedAccount])
    expect(html).toContain('Exhausted')
    expect(html).toContain('plan limit')
    expect(html).toContain('retry ~30m')
  })

  test('a healthy account row stays a plain Available pill', () => {
    const html = renderAccounts([{ id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'available' }])
    expect(html).toContain('Available')
    expect(html).not.toContain('Exhausted')
    expect(html).not.toContain('Reset health for')
  })

  test('offers Reset only on exhausted rows, and only to writers', () => {
    expect(renderAccounts([exhaustedAccount])).toContain('aria-label="Reset health for Work"')
    expect(renderAccounts([exhaustedAccount], false)).not.toContain('Reset health for')
  })

  test('a disabled account reads Disabled, with no exhaustion detail or reset', () => {
    // The row already explains why it is unusable; an exhaustion record behind a
    // switched-off account is not what the operator needs to act on.
    const html = renderAccounts([{ ...exhaustedAccount, enabled: false }])
    expect(html).toContain('Disabled')
    expect(html).not.toContain('plan limit')
    expect(html).not.toContain('Reset health for')
  })

  test('points a credential failure at re-authorizing instead of offering Reset', () => {
    // Routing already treats these as ready — the record IS the remediation
    // signal, so clearing it would only hide what the operator must fix.
    const html = renderAccounts([
      { ...exhaustedAccount, healthReason: 'invalid-credential', healthMessage: 'Provider credential is invalid.' },
    ])
    expect(html).toContain('invalid credential')
    expect(html).toContain('Re-authorize')
    expect(html).not.toContain('Reset health for')
  })

  test('renders no empty detail element when the record carries neither reason nor reset', () => {
    const html = renderAccounts([{ id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'exhausted' }])
    expect(html).toContain('Exhausted')
    expect(html).not.toContain('<span class="text-xs text-muted"></span>')
  })

  test('shows a provider-level pill when the provider record — not an account — is exhausted', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: false,
      health: 'exhausted',
      healthReason: 'rate-limit',
      retryAt: Date.now() + 60_000,
      accounts: [{ id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'available' }],
    })
    expect(html).toContain('Exhausted')
    expect(html).toContain('rate limit')
    expect(html).toContain('aria-label="Reset health for anthropic"')
  })

  test('shows a provider-level Disabled pill without a reset action', () => {
    const html = renderRow({
      provider: 'anthropic',
      type: 'api_key',
      hasCredential: true,
      configured: true,
      disabled: true,
      accounts: [{ id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'available' }],
    })
    expect(html).toContain('Disabled')
    expect(html).not.toContain('Reset health for')
  })

  test('resetting an exhausted account calls the endpoint and the row returns to Available', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const requests: { url: string; method?: string }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method })
      return Response.json({ provider: 'anthropic', health: 'available', accounts: [] })
    }) as typeof fetch
    try {
      const { createRoot } = await import('react-dom/client')
      const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const render = (accounts: any[]) => (
        <QueryClientProvider client={queryClient}>
          <ProviderAccountsList providerId="anthropic" accounts={accounts as ProviderAccountEntry[]} canWrite={true} />
        </QueryClientProvider>
      )
      await dom.act(async () => {
        root.render(render([exhaustedAccount]))
      })
      await dom.act(async () => {
        ;(container.querySelector('[aria-label="Reset health for Work"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(
        requests.find((r) => r.url.endsWith('/api/provider-auth/anthropic/accounts/acc_1/health/reset'))
      ).toMatchObject({ method: 'POST' })

      // The refreshed query result flips the row back to Available.
      await dom.act(async () => {
        root.render(render([{ id: 'acc_1', label: 'Work', enabled: true, type: 'api_key', health: 'available' }]))
      })
      expect(container.textContent).toContain('Available')
      expect(container.querySelector('[aria-label="Reset health for Work"]')).toBeNull()
      await dom.act(async () => root.unmount())
      queryClient.clear()
    } finally {
      await dom.cleanup()
    }
  })
})
