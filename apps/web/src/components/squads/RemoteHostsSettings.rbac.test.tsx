import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'

let permissions = new Set<string>()
let permissionsLoading = false

const { RemoteHostsSettings } = await import('./RemoteHostsSettings')

function renderRemoteHostsSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.remoteHosts('squad-1'), [
    {
      id: 'host-1',
      name: 'staging',
      description: null,
      sshHost: '10.1.2.3',
      sshPort: 22,
      sshUser: 'deploy',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ])
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions: [...permissions] })
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RemoteHostsSettings squadId="squad-1" />
    </QueryClientProvider>
  )
}

describe('RemoteHostsSettings RBAC gating', () => {
  beforeEach(() => {
    permissions = new Set<string>()
    permissionsLoading = false
  })

  test('hides the per-host Check control unless remote-hosts:write is allowed (the endpoint needs squad write)', () => {
    const deniedHtml = renderRemoteHostsSettings()
    expect(deniedHtml).not.toContain('>Check<')

    permissions.add('remote-hosts:write')
    const allowedHtml = renderRemoteHostsSettings()
    expect(allowedHtml).toContain('>Check<')
  })
})
