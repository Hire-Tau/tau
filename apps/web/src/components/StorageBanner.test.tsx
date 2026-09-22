import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { PermissionsProvider } from '../hooks/usePermissions'
import { queryKeys } from '../queryKeys'
import { StorageBanner } from './StorageBanner'
import { StorageMonitorSettings } from './settings/StorageMonitorSettings'

const config = { intervalHours: 12, alertsEnabled: true, thresholds: [80, 90, 95], nextScanAt: null }
for (const allowed of [true, false]) {
  test(`storage warnings ${allowed ? 'show stale capacity and a settings link' : 'hide cached machine details without permission'}`, () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.system.storageStatus(), {
      supported: true,
      scanning: false,
      scannedAt: '2026-09-22T00:00:00Z',
      error: null,
      monitoring: config,
      warnings: [
        {
          machineId: 'a',
          machineName: 'Worker machine',
          percent: 96,
          threshold: 95,
          measuredAt: '2026-09-22T00:00:00Z',
          stale: true,
        },
      ],
    })
    try {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <PermissionsProvider
              usePermissions={() => ({ can: () => allowed, permissions: [], isLoading: false, isError: false })}
            >
              <StorageBanner />
            </PermissionsProvider>
          </QueryClientProvider>
        </MemoryRouter>
      )
      if (allowed) {
        expect(html).toContain('96.0')
        expect(html).toContain('current usage is unknown')
        expect(html).toContain('/settings?section=storage')
      } else expect(html).toBe('')
    } finally {
      client.clear()
    }
  })
}
test('storage monitoring form exposes saved interval, thresholds and inbox preference', () => {
  const client = new QueryClient()
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <StorageMonitorSettings config={config} />
      </QueryClientProvider>
    )
    expect(html).toContain('value="12"')
    expect(html).toContain('value="80,90,95"')
    expect(html).toContain('Send threshold alerts to the system inbox')
  } finally {
    client.clear()
  }
})
