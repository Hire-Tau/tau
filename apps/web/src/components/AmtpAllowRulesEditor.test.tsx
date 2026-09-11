import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import type { AgentAmtpAllowRule } from '../api/amtp'
import { AmtpAllowRulesEditor } from './AmtpAllowRulesEditor'

function render(opts: { canWrite: boolean; rules?: AgentAmtpAllowRule[] }): string {
  const qc = new QueryClient()
  qc.setQueryData(queryKeys.amtp.allowRules('a1'), opts.rules ?? [])
  qc.setQueryData(queryKeys.amtp.peers(), [
    {
      id: 'p1',
      localAlias: 'acme',
      instanceId: 'acme-id',
      baseUrl: 'https://acme/api',
      publicKeyPem: 'k',
      status: 'active',
      createdAt: '',
    },
  ])
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AmtpAllowRulesEditor agentId="a1" canWrite={opts.canWrite} />
    </QueryClientProvider>
  )
}

describe('AmtpAllowRulesEditor', () => {
  test('renders nothing when the viewer lacks amtp:write', () => {
    expect(render({ canWrite: false })).toBe('')
  })

  test('lists existing rules and offers the peer dropdown when writable', () => {
    const html = render({
      canWrite: true,
      rules: [
        {
          id: 'r1',
          targetAgentId: 'a1',
          peerInstanceId: 'acme-id',
          principalKind: 'handle',
          principalValue: 'bob',
          createdAt: '',
        },
      ],
    })
    expect(html).toContain('acme-id')
    expect(html).toContain('Handle:bob')
    expect(html).toContain('>Add rule<')
    expect(html).toContain('acme') // peer option label
  })

  test('shows the empty-state hint when there are no rules', () => {
    const html = render({ canWrite: true, rules: [] })
    expect(html).toContain('No allow rules')
  })
})
