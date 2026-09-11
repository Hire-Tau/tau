import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'

import { queries } from '../../queryOptions'

const { MemorySearchPanel } = await import('./MemorySearchPanel')

describe('MemorySearchPanel', () => {
  test('renders a query input and source filters', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemorySearchPanel squadId="squad-aaaa" />
      </QueryClientProvider>
    )

    expect(html).toContain('type="search"')
    expect(html.toLowerCase()).not.toContain('source squad')
    expect(html.toLowerCase()).toContain('source type')
    expect(html).toContain('Slack threads')
    expect(html).toContain('GitHub issues')
    expect(html).toContain('Linear issues')
  })
})

test('shows the source selector when memory has multiple distinct squad sources', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(queries.squads.grants.inbound('squad-a').queryKey, [{ sourceSquadId: 'squad-b' }])
  queryClient.setQueryData(queries.squads.list('active').queryKey, [
    { id: 'squad-a', name: 'Alpha' },
    { id: 'squad-b', name: 'Beta' },
  ])
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemorySearchPanel squadId="squad-a" />
    </QueryClientProvider>
  )
  expect(html).toContain('Source squads')
  expect(html).toContain('Alpha')
  expect(html).toContain('Beta')
})
