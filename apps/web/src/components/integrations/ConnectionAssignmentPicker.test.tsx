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

const selection = {
  providerKey: 'bigbrain',
  assignment: { id: 'one', providerKey: 'bigbrain', displayName: 'Primary', enabled: true, healthState: 'healthy' },
  connections: [
    { id: 'one', providerKey: 'bigbrain', displayName: 'Primary', enabled: true, healthState: 'healthy' },
    { id: 'two', providerKey: 'bigbrain', displayName: 'Unavailable', enabled: false, healthState: 'unknown' },
    { id: 'three', providerKey: 'bigbrain', displayName: 'Secondary', enabled: true, healthState: 'healthy' },
  ],
}

beforeEach(async () => {
  harness = await acquireDomHarness({ url: 'http://localhost' })
  ;({ root, container } = harness.createRoot())
  oldFetch = globalThis.fetch
  requests = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return Response.json(selection)
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = oldFetch
  await harness.cleanup()
})

async function render(canWrite: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(integrationQueryKeys.squad('squad-1', 'bigbrain'), selection)
  const { ConnectionAssignmentPicker } = await import('./ConnectionAssignmentPicker')
  await harness.act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectionAssignmentPicker
          squadId="squad-1"
          provider="bigbrain"
          presentation={{ label: 'Bigbrain' }}
          canRead
          canWrite={canWrite}
        />
      </QueryClientProvider>
    )
  )
  return client
}

describe('ConnectionAssignmentPicker', () => {
  test('renders only redacted assignment summary and disabled options', async () => {
    await render(false)
    expect(container.textContent).toContain('Primary')
    expect(container.textContent).toContain('Unavailable')
    expect(container.innerHTML).not.toContain('apiBase')
    expect(container.querySelector('select')).toBeNull()
  })

  test('retries degraded projection without mutating the assignment', async () => {
    const client = await render(true)
    await harness.act(async () => {
      client.setQueryData(integrationQueryKeys.squad('squad-1', 'bigbrain'), {
        ...selection,
        projection: { status: 'degraded', lastErrorCode: 'install_failed' },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    await harness.act(async () => {
      fireEvent.click(retry)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(requests.find((request) => request.url.includes('/projection/retry'))).toMatchObject({ method: 'POST' })
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
  })

  test('assigns and unassigns while invalidating squad and pool queries', async () => {
    const client = await render(true)
    client.setQueryData(integrationQueryKeys.pool('bigbrain'), [])
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Bigbrain connection for this squad"]'
    )!
    await harness.act(async () => {
      fireEvent.change(select, { target: { value: 'three' } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(requests.find((request) => request.method === 'PUT')).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ connectionId: 'three' }),
    })

    await harness.act(async () => {
      fireEvent.change(select, { target: { value: '' } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(requests.find((request) => request.method === 'DELETE')).toMatchObject({ method: 'DELETE' })
    expect(client.getQueryState(integrationQueryKeys.squad('squad-1', 'bigbrain'))).toBeDefined()
    expect(client.getQueryState(integrationQueryKeys.pool('bigbrain'))?.isInvalidated).toBe(true)
  })
})
