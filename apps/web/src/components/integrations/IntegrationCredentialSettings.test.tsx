import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntegrationCredentialSettings } from './IntegrationCredentialSettings'
import { integrationQueryKeys } from '../../queryKeys'
import { IntegrationDirectoryCard } from '../settings/IntegrationsSection'
import type { IntegrationCatalogItem } from '../../api/integrations'

test('missing required fields are required in the form while saved secrets need no re-entry', () => {
  const client = new QueryClient()
  client.setQueryData(integrationQueryKeys.serviceSettings('fixture'), {
    fields: [
      {
        key: 'CONTACT',
        label: 'Contact',
        required: true,
        configured: false,
        secret: false,
        placeholder: 'mailto:admin@example.com',
      },
      { key: 'SAVED', label: 'Saved key', required: true, configured: true, secret: true, placeholder: 'key' },
      { key: 'OPTIONAL', label: 'Optional', configured: false, secret: false, placeholder: 'Optional value' },
    ],
  })
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <IntegrationCredentialSettings provider="fixture" kind="service" canWrite />
      </QueryClientProvider>
    )
    const inputs = html.match(/<input[^>]*>/g)!
    expect(inputs[0]).toContain('required=""')
    expect(inputs[1]).not.toContain(' required=""')
    expect(inputs[1]).toContain('aria-required="true"')
    expect(inputs[2]).not.toContain(' required=""')
    expect(html).toContain('(required)')
    expect(inputs[0]).toContain('aria-invalid="true"')
    expect(inputs[0]).toContain('aria-describedby=')
    expect(html).toContain('Contact is required.')
    expect(html.indexOf('Contact is required.')).toBeGreaterThan(html.indexOf(inputs[0]))
    expect(html).not.toContain('Saved key is required.')
    expect(html).not.toContain('Optional is required.')
  } finally {
    client.clear()
  }
})

test.each(['apple-push', 'web-push'])(
  '%s hides platform-owned settings but keeps local setup available',
  (provider) => {
    const client = new QueryClient()
    const entry: IntegrationCatalogItem = {
      key: provider,
      label: provider,
      description: 'Push notifications',
      enabled: true,
      connectionMode: 'service',
      capabilities: [],
      assignable: false,
      authorization: { kind: 'credential' },
    }
    const render = () =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <IntegrationDirectoryCard entry={entry} canWrite expanded setExpanded={() => {}} />
        </QueryClientProvider>
      )
    try {
      const field = { key: 'PUSH_KEY', label: 'Push credential', managed: true, configured: true, secret: true }
      client.setQueryData(integrationQueryKeys.serviceSettings(provider), { fields: [field] })
      const managed = render()
      expect(managed).toContain('Managed by the platform.')
      expect(managed).not.toContain('Push credential')
      expect(managed).not.toContain('<form')
      expect(managed).not.toContain(`aria-controls="integration-settings-${provider}"`)
      expect(managed).toContain('role="switch"')

      client.setQueryData(integrationQueryKeys.serviceSettings(provider), { fields: [{ ...field, managed: false }] })
      const local = render()
      expect(local).not.toContain('Managed by the platform.')
      expect(local).toContain('Push credential')
      expect(local).toContain('<form')
      expect(local).toContain(`aria-controls="integration-settings-${provider}"`)
    } finally {
      client.clear()
    }
  }
)

test('partially managed push settings expose only the fields the user can configure', () => {
  const client = new QueryClient()
  client.setQueryData(integrationQueryKeys.serviceSettings('apple-push'), {
    fields: [
      { key: 'APNS_KEY_P8', label: 'Private key', managed: true, configured: true, secret: true },
      { key: 'APNS_ENV', label: 'Environment', managed: false, configured: false, secret: false },
    ],
  })
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <IntegrationCredentialSettings provider="apple-push" kind="service" canWrite hideManagedFields />
      </QueryClientProvider>
    )
    expect(html).not.toContain('Private key')
    expect(html).toContain('Environment')
    expect(html.match(/<input /g)).toHaveLength(1)
    expect(html).toContain('Save credentials')
  } finally {
    client.clear()
  }
})
