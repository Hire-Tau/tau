import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueryKeys } from '../../queryKeys'

let harness: Awaited<ReturnType<typeof acquireDomHarness>>
let root: import('react-dom/client').Root
let container: HTMLDivElement
let oldFetch: typeof globalThis.fetch
let requests: { url: string; method: string; body: string }[]
let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const connection = {
  id: 'connection-1',
  providerKey: 'bigbrain',
  adapterVersion: 1,
  displayName: 'Primary Brain',
  configuration: { version: 1, apiBase: 'https://brain.example' },
  credentialConfigured: true,
  enabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  grantedScopes: ['vault:read'],
  validatedAt: '2026-01-01',
  validationExpiresAt: '2026-01-02',
  lastErrorCode: null,
  usage: { squadCount: 0, squads: [] },
}
const secondConnection = {
  ...connection,
  id: 'connection-2',
  displayName: 'Secondary Brain',
  configuration: { version: 1, apiBase: 'https://second.example' },
  enabled: false,
}

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  fetchHandler = async (_input, init) => Response.json((init?.method ?? 'GET') === 'GET' ? [connection] : connection)
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return fetchHandler(input, init)
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

async function render(data: unknown[] | undefined, canRead = true, canWrite = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  if (data !== undefined) client.setQueryData(integrationQueryKeys.pool('bigbrain'), data)
  const { BigbrainIntegrationSettings } = await import('./BigbrainIntegrationSettings')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BigbrainIntegrationSettings canRead={canRead} canWrite={canWrite} />
      </QueryClientProvider>
    )
  )
  return { client, BigbrainIntegrationSettings }
}

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  return [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
}

async function settle() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('BigbrainIntegrationSettings', () => {
  test('does not query or render without global read permission', async () => {
    await render(undefined, false, false)
    expect(container.innerHTML).toBe('')
    expect(requests).toHaveLength(0)
  })

  test('distinguishes pool loading and query errors from an empty pool', async () => {
    fetchHandler = async () => new Promise<Response>(() => {})
    await render(undefined)
    expect(container.textContent).toContain('Loading Bigbrain connections')
  })

  test('renders a bounded pool query error', async () => {
    fetchHandler = async () =>
      new Response(JSON.stringify({ error: `unavailable ${'x'.repeat(300)}` }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    await render(undefined)
    await harness.act(settle)
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('unavailable')
    expect(alert!.textContent!.length).toBeLessThanOrEqual(200)
  })

  test('renders every pooled connection with independent lifecycle state', async () => {
    await render([connection, secondConnection], true, false)
    expect(container.textContent).toContain('Primary Brain')
    expect(container.textContent).toContain('Secondary Brain')
    expect(container.textContent).toContain('Enabled · healthy')
    expect(container.textContent).toContain('Configured · disabled')
    expect(container.textContent).not.toContain('credentialRef')
  })

  test('creates a named connection with a non-autofilled password input', async () => {
    await render([])
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain display name"]')!
    const base = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain API base"]')!
    const credential = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain credential"]')!
    expect(credential.type).toBe('password')
    expect(credential.autocomplete).toBe('off')
    await harness.act(async () => {
      fireEvent.input(name, { target: { value: 'Production Brain' } })
      fireEvent.input(base, { target: { value: 'https://brain.example' } })
      fireEvent.input(credential, { target: { value: 'fixture-secret' } })
      credential.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await settle()
    })
    expect(requests.find((request) => request.method === 'POST')?.body).toContain('fixture-secret')
    expect(container.textContent).not.toContain('fixture-secret')
  })

  test('locks the submitted create draft until the pending request settles', async () => {
    fetchHandler = async (_input, init) =>
      init?.method === 'POST' ? new Promise<Response>(() => {}) : Response.json([])
    await render([])
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain display name"]')!
    const base = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain API base"]')!
    const credential = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain credential"]')!
    await harness.act(async () => {
      fireEvent.input(name, { target: { value: 'Production Brain' } })
      fireEvent.input(base, { target: { value: 'https://brain.example' } })
      fireEvent.input(credential, { target: { value: 'fixture-secret' } })
      credential.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(name.disabled).toBe(true)
    expect(base.disabled).toBe(true)
    expect(credential.disabled).toBe(true)
  })

  test('clears a canceled credential replacement before reopening', async () => {
    await render([connection])
    await harness.act(async () => button('Replace credential').click())
    let input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement Bigbrain credential for Primary Brain"]'
    )!
    await harness.act(async () => {
      fireEvent.input(input, { target: { value: 'canceled-secret' } })
      button('Cancel').click()
    })
    await harness.act(async () => button('Replace credential').click())
    input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement Bigbrain credential for Primary Brain"]'
    )!
    expect(input.value).toBe('')
    expect(container.textContent).not.toContain('canceled-secret')
  })

  test('shows lifecycle data but no controls without global write permission', async () => {
    await render([connection], true, false)
    expect(container.textContent).toContain('Enabled · healthy')
    for (const label of ['Validate', 'Disable', 'Replace credential', 'Remove', 'Create and validate']) {
      expect(container.textContent).not.toContain(label)
    }
  })

  test.each([
    ['disable', 'POST', 'Disable'],
    ['remove', 'DELETE', 'Confirm remove'],
  ] as const)('shows authoritative squad usage and confirms %s explicitly', async (operation, method, trigger) => {
    let conflicted = false
    fetchHandler = async (_input, init) => {
      if ((init?.method ?? 'GET') === method && !conflicted) {
        conflicted = true
        return Response.json(
          {
            error: 'Integration connection is assigned to squads',
            usage: {
              squadCount: 2,
              squads: [
                { id: 'a', name: 'Alpha' },
                { id: 'b', name: 'Beta' },
              ],
            },
          },
          { status: 409 }
        )
      }
      return Response.json((init?.method ?? 'GET') === 'GET' ? [connection] : connection)
    }
    await render([connection])
    if (operation === 'remove') {
      await harness.act(async () => button('Remove').click())
    }
    await harness.act(async () => {
      button(trigger).click()
      await settle()
    })
    expect(container.textContent).toContain('used by 2 squads')
    expect(container.textContent).toContain('Alpha, Beta')
    await harness.act(async () => {
      button('Confirm impact').click()
      await settle()
    })
    const calls = requests.filter((request) => request.method === method)
    expect(calls).toHaveLength(2)
    if (operation === 'disable') expect(calls[1]!.body).toContain('confirmAssigned')
    else expect(calls[1]!.url).toContain('confirmAssigned=true')
  })

  test('retains the replacement draft through authoritative usage confirmation', async () => {
    let conflicted = false
    fetchHandler = async (input, init) => {
      if (String(input).includes('/credential') && !conflicted) {
        conflicted = true
        return Response.json(
          { error: 'in use', usage: { squadCount: 1, squads: [{ id: 'a', name: 'Alpha' }] } },
          { status: 409 }
        )
      }
      return Response.json((init?.method ?? 'GET') === 'GET' ? [connection] : connection)
    }
    await render([connection])
    await harness.act(async () => button('Replace credential').click())
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement Bigbrain credential for Primary Brain"]'
    )!
    await harness.act(async () => {
      fireEvent.input(input, { target: { value: 'rotated-secret' } })
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await settle()
    })
    expect(input.value).toBe('rotated-secret')
    await harness.act(async () => {
      button('Confirm impact').click()
      await settle()
    })
    const puts = requests.filter((request) => request.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts[1]!.body).toContain('confirmAssigned')
  })

  test('a delayed replacement for one connection cannot clear a newer connection draft', async () => {
    let resolveReplacement!: (response: Response) => void
    const delayed = new Promise<Response>((resolve) => (resolveReplacement = resolve))
    fetchHandler = async (input, init) => {
      if (String(input).includes('connection-1/credential') && init?.method === 'PUT') return delayed
      return Response.json((init?.method ?? 'GET') === 'GET' ? [connection, secondConnection] : connection)
    }
    await render([connection, secondConnection])
    const cards = container.querySelectorAll('article')
    await harness.act(async () => button('Replace credential', cards[0]).click())
    const first = container.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement Bigbrain credential for Primary Brain"]'
    )!
    await harness.act(async () => {
      fireEvent.input(first, { target: { value: 'first-secret' } })
      first.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      button('Replace credential', cards[1]).click()
    })
    const second = container.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement Bigbrain credential for Secondary Brain"]'
    )!
    await harness.act(async () => fireEvent.input(second, { target: { value: 'newer-secret' } }))
    await harness.act(async () => {
      resolveReplacement(Response.json(connection))
      await settle()
    })
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Replacement Bigbrain credential for Secondary Brain"]'
      )?.value
    ).toBe('newer-secret')
  })

  test('a delayed replacement conflict cannot arm A with B credential after switching editors', async () => {
    let resolveReplacement!: (response: Response) => void
    const delayed = new Promise<Response>((resolve) => (resolveReplacement = resolve))
    fetchHandler = async (input, init) => {
      if (String(input).includes('connection-1/credential') && init?.method === 'PUT') return delayed
      return Response.json((init?.method ?? 'GET') === 'GET' ? [connection, secondConnection] : connection)
    }
    await render([connection, secondConnection])
    const cards = container.querySelectorAll('article')
    await harness.act(async () => button('Replace credential', cards[0]).click())
    const first = container.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement Bigbrain credential for Primary Brain"]'
    )!
    await harness.act(async () => {
      fireEvent.input(first, { target: { value: 'a-secret' } })
      first.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      button('Replace credential', cards[1]).click()
    })
    const second = container.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement Bigbrain credential for Secondary Brain"]'
    )!
    await harness.act(async () => fireEvent.input(second, { target: { value: 'b-secret' } }))
    await harness.act(async () => {
      resolveReplacement(
        Response.json(
          { error: 'in use', usage: { squadCount: 1, squads: [{ id: 'a', name: 'Alpha' }] } },
          { status: 409 }
        )
      )
      await settle()
    })
    expect(container.textContent).not.toContain('Confirm impact')
    expect(second.value).toBe('b-secret')
  })

  test('canceling a pending replacement prevents its delayed conflict from resurrecting confirmation', async () => {
    let resolveReplacement!: (response: Response) => void
    const delayed = new Promise<Response>((resolve) => (resolveReplacement = resolve))
    fetchHandler = async (input, init) => {
      if (String(input).includes('/credential') && init?.method === 'PUT') return delayed
      return Response.json((init?.method ?? 'GET') === 'GET' ? [connection] : connection)
    }
    await render([connection])
    await harness.act(async () => button('Replace credential').click())
    const input = container.querySelector<HTMLInputElement>('[aria-label^="Replacement Bigbrain credential"]')!
    await harness.act(async () => {
      fireEvent.input(input, { target: { value: 'a-secret' } })
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(input.disabled).toBe(true)
    await harness.act(async () => button('Cancel').click())
    await harness.act(async () => {
      resolveReplacement(
        Response.json(
          { error: 'in use', usage: { squadCount: 1, squads: [{ id: 'a', name: 'Alpha' }] } },
          { status: 409 }
        )
      )
      await settle()
    })
    expect(container.textContent).not.toContain('Confirm impact')
    expect(container.querySelector('[aria-label^="Replacement Bigbrain credential"]')).toBeNull()
  })

  test('a delayed stale usage conflict cannot resurrect confirmation over a newer operation', async () => {
    let resolveDisable!: (response: Response) => void
    const delayed = new Promise<Response>((resolve) => (resolveDisable = resolve))
    fetchHandler = async (input, init) => {
      if (String(input).includes('connection-1/disable')) return delayed
      return Response.json((init?.method ?? 'GET') === 'GET' ? [connection, secondConnection] : secondConnection)
    }
    await render([connection, secondConnection])
    const cards = container.querySelectorAll('article')
    await harness.act(async () => {
      button('Disable', cards[0]).click()
      await Promise.resolve()
      button('Enable', cards[1]).click()
      await settle()
    })
    expect(container.textContent).toContain('Connection enabled.')
    await harness.act(async () => {
      resolveDisable(
        Response.json(
          { error: 'in use', usage: { squadCount: 1, squads: [{ id: 'a', name: 'Alpha' }] } },
          { status: 409 }
        )
      )
      await settle()
    })
    expect(container.textContent).not.toContain('Confirm impact')
    expect(container.textContent).toContain('Connection enabled.')
  })

  test('pending operations keep every control for their target disabled without blocking another row', async () => {
    fetchHandler = async (input, init) => {
      if (String(input).includes('connection-1/validate')) return new Promise<Response>(() => {})
      return Response.json((init?.method ?? 'GET') === 'GET' ? [connection, secondConnection] : connection)
    }
    await render([connection, secondConnection])
    const cards = container.querySelectorAll('article')
    await harness.act(async () => {
      button('Validate', cards[0]).click()
      await Promise.resolve()
    })
    expect([...cards[0]!.querySelectorAll('button')].every((control) => control.disabled)).toBe(true)
    expect(button('Validate', cards[1]).disabled).toBe(false)
  })

  test('permission loss clears all secret-bearing drafts and invalidates stale completions', async () => {
    const { client, BigbrainIntegrationSettings } = await render([connection])
    const createCredential = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain credential"]')!
    await harness.act(async () => {
      fireEvent.input(createCredential, { target: { value: 'create-secret' } })
      button('Replace credential').click()
    })
    const replacement = container.querySelector<HTMLInputElement>(
      'input[aria-label="Replacement Bigbrain credential for Primary Brain"]'
    )!
    await harness.act(async () => fireEvent.input(replacement, { target: { value: 'replacement-secret' } }))
    await harness.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <BigbrainIntegrationSettings canRead canWrite={false} />
        </QueryClientProvider>
      )
    )
    await harness.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <BigbrainIntegrationSettings canRead canWrite />
        </QueryClientProvider>
      )
    )
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain credential"]')?.value).toBe('')
    expect(container.querySelector('[aria-label^="Replacement Bigbrain credential"]')).toBeNull()
  })

  test('changing the rendered pool target set disarms an armed remove confirmation', async () => {
    const { client } = await render([connection])
    await harness.act(async () => button('Remove').click())
    expect(container.textContent).toContain('Confirm remove')
    await harness.act(async () => {
      client.setQueryData(integrationQueryKeys.pool('bigbrain'), [connection, secondConnection])
      await settle()
    })
    expect(container.textContent).not.toContain('Confirm remove')
    expect(container.textContent).toContain('Remove')
  })

  test.each([
    [{ ...connection, authState: 'invalid' }, 'Invalid'],
    [{ ...connection, enabled: false }, 'Configured · disabled'],
    [{ ...connection, healthState: 'degraded' }, 'Enabled · degraded'],
    [{ ...connection, healthState: 'unreachable' }, 'Enabled · unreachable'],
    [{ ...connection, healthState: 'unknown' }, 'Enabled · health unknown'],
  ] as const)('renders the complete lifecycle state matrix', async (value, label) => {
    await render([value], true, false)
    expect(container.textContent).toContain(label)
  })

  test.each([
    ['create', 'Creating the connection'],
    ['validate', 'Validating the connection'],
    ['enable', 'Enabling the connection'],
    ['disable', 'Disabling the connection'],
    ['replace', 'Replacing the credential'],
    ['remove', 'Removing the connection'],
  ] as const)('bounds %s operation errors', async (operation, expected) => {
    fetchHandler = async (_input, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json(operation === 'enable' ? [secondConnection] : [connection])
        : new Response(JSON.stringify({ error: `failure ${'x'.repeat(300)}` }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
    await render(operation === 'enable' ? [secondConnection] : [connection])
    await harness.act(async () => {
      if (operation === 'create') {
        const name = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain display name"]')!
        const base = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain API base"]')!
        const secret = container.querySelector<HTMLInputElement>('input[aria-label="Bigbrain credential"]')!
        fireEvent.input(name, { target: { value: 'New' } })
        fireEvent.input(base, { target: { value: 'https://new.example' } })
        fireEvent.input(secret, { target: { value: 'secret' } })
        secret.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      } else if (operation === 'replace') {
        button('Replace credential').click()
        await Promise.resolve()
        const secret = container.querySelector<HTMLInputElement>('[aria-label^="Replacement Bigbrain credential"]')!
        fireEvent.input(secret, { target: { value: 'secret' } })
        secret.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      } else if (operation === 'remove') {
        button('Remove').click()
        await settle()
        button('Confirm remove').click()
      } else {
        button(operation === 'enable' ? 'Enable' : operation === 'disable' ? 'Disable' : 'Validate').click()
      }
      await settle()
    })
    const alert = [...container.querySelectorAll('[role="alert"]')].at(-1)
    expect(alert?.textContent).toContain(`${expected} failed:`)
    expect(alert!.textContent!.length).toBeLessThanOrEqual(200)
  })

  test('bounds operation errors and keeps another connection controls usable', async () => {
    fetchHandler = async (_input, init) =>
      (init?.method ?? 'GET') === 'POST'
        ? new Response(JSON.stringify({ error: `failure ${'x'.repeat(300)}` }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        : Response.json([connection, secondConnection])
    await render([connection, secondConnection])
    const cards = container.querySelectorAll('article')
    await harness.act(async () => {
      button('Validate', cards[0]).click()
      await settle()
    })
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Validating the connection failed:')
    expect(alert!.textContent!.length).toBeLessThanOrEqual(200)
    expect(button('Validate', cards[1]).disabled).toBe(false)
  })
})
