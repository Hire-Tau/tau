import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../queryKeys'
import { usePermissions } from './usePermissions'

function renderProbe(permissions: string[] | undefined, requested: string, squadId?: string): string {
  const queryClient = new QueryClient()
  if (permissions) {
    queryClient.setQueryData(queryKeys.auth.permissions(squadId), { permissions })
  }

  function Probe() {
    const { can, isLoading } = usePermissions(squadId)
    return <span>{isLoading ? 'loading' : can(requested) ? 'allowed' : 'denied'}</span>
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>
  )
}

describe('usePermissions', () => {
  test('matches permissions using shared wildcard semantics', () => {
    expect(renderProbe(['agents:*'], 'agents:run')).toContain('allowed')
    expect(renderProbe(['agents:read'], 'agents:run')).toContain('denied')
  })

  test('uses squad-scoped cache entries and degrades closed while loading', () => {
    expect(renderProbe(['agents:run'], 'agents:run', 'squad-1')).toContain('allowed')
    expect(renderProbe(undefined, 'agents:run', 'squad-1')).toContain('loading')
  })
})
