import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'

let permissions = new Set<string>()
let permissionsLoading = false

const { MemorySettings } = await import('./MemorySettings')

function renderMemorySettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.basic('squad-1'), {
    id: 'squad-1',
    metadata: {
      memory: {
        enabled: true,
        embeddingModel: 'text-embedding-3-small',
      },
    },
  })
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions: [...permissions] })
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemorySettings squadId="squad-1" />
    </QueryClientProvider>
  )
}

describe('MemorySettings RBAC gating', () => {
  beforeEach(() => {
    permissions = new Set<string>()
    permissionsLoading = false
  })

  test('hides edit and disables write actions unless memory:write is allowed', () => {
    const deniedHtml = renderMemorySettings()
    expect(deniedHtml).not.toContain('Edit')
    expect(deniedHtml).toContain('disabled=""')

    permissions.add('memory:write')
    const allowedHtml = renderMemorySettings()
    expect(allowedHtml).toContain('Edit')
  })
})
