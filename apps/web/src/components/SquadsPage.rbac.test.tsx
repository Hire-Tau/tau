import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../queryKeys'

let permissions = new Set<string>()
let permissionsLoading = false

const dependencies = {
  SquadList: () => <div data-test-slot="squad-list">Squad list fixture</div>,
  CreateSquadModal: () => <div data-test-slot="create-modal" />,
}

import { SquadsPage } from './SquadsPage'

function renderSquadsPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.list('all'), [])
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions(undefined), { permissions: [...permissions] })
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SquadsPage dependencies={dependencies} />
    </QueryClientProvider>
  )
}

describe('SquadsPage RBAC gating', () => {
  beforeEach(() => {
    permissions = new Set<string>()
    permissionsLoading = false
  })

  test('hides New Squad unless squads:create is allowed', () => {
    expect(renderSquadsPage()).not.toContain('New Squad')
    expect(renderSquadsPage()).toContain('data-test-slot="squad-list"')

    permissions.add('squads:create')

    expect(renderSquadsPage()).toContain('New Squad')
  })

  test('degrades closed while permissions are loading', () => {
    permissions.add('squads:create')
    permissionsLoading = true

    expect(renderSquadsPage()).not.toContain('New Squad')
  })

  test('always renders the list without the retired view picker', () => {
    const html = renderSquadsPage()
    expect(html).toContain('data-test-slot="squad-list"')
    expect(html).not.toContain('>List<')
    expect(html).not.toContain('>Graph<')
    expect(html).not.toContain('>Universe<')
  })
})
