import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import { queryKeys } from '../queryKeys'
import { AgentScopesPanel } from './AgentScopesPanel'

function renderPanel(scopes: string[], permissions: string[] = ['agents:scopes:read', 'agents:scopes:manage']): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  queryClient.setQueryData(
    queryKeys.agents.scopes('agent-1'),
    scopes.map((permission, index) => ({
      id: `scope-${index}`,
      agentId: 'agent-1',
      permission,
      grantedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }))
  )
  queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions })

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AgentScopesPanel agentId="agent-1" />
    </QueryClientProvider>
  )
}

describe('AgentScopesPanel', () => {
  test('renders granted scopes as chips', () => {
    const html = renderPanel(['sandbox:logs', 'system:restart'])

    expect(html).toContain('Extra Scopes')
    expect(html).toContain('sandbox:logs')
    expect(html).toContain('system:restart')
  })

  test('renders empty state when no scopes are granted', () => {
    const html = renderPanel([])

    expect(html).toContain('No extra scopes granted')
  })

  test('hides management controls without manage permission', () => {
    const html = renderPanel(['sandbox:logs'], ['agents:scopes:read'])

    expect(html).toContain('sandbox:logs')
    expect(html).not.toContain('Grant selected')
    expect(html).not.toContain('Revoke')
  })

  test('contains scope mutation invalidation hooks', () => {
    const source = readFileSync(join(import.meta.dir, 'AgentScopesPanel.tsx'), 'utf8')

    expect(source).toContain('queryKeys.agents.scopes(agentId)')
    expect(source).toContain('queryKeys.agents.detail(agentId)')
    expect(source).toContain('queryKeys.agents.all')
  })
})
