import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../../queryKeys'
import { SharingTab } from './SharingTab'

let permissions = new Set<string>()
let permissionsLoading = false

const sharingTabComponents = {
  CreateGrantForm: () => <div data-test-slot="create">Create fixture</div>,
  InboundGrantsList: () => <div data-test-slot="inbound">Inbound fixture</div>,
  OutboundGrantsList: () => <div data-test-slot="outbound">Outbound fixture</div>,
}

function renderSharingTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions: [...permissions] })
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SharingTab squadId="squad-1" components={sharingTabComponents} />
    </QueryClientProvider>
  )
}

describe('SharingTab permission gates', () => {
  beforeEach(() => {
    permissions = new Set<string>()
    permissionsLoading = false
  })

  test('hides memory sharing create action without grants:write', () => {
    const html = renderSharingTab()

    expect(html).not.toContain('Share memory')
    expect(html).toContain('data-test-slot="outbound"')
    expect(html).toContain('data-test-slot="inbound"')
  })

  test('shows memory sharing create action with grants:write', () => {
    permissions.add('grants:write')

    const html = renderSharingTab()

    expect(html).toContain('Share memory')
  })
})
