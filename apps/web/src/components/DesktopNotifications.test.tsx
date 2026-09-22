import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { acquireDomHarness } from '../test/domHarness'
import { desktopQueryKeys } from '../queryKeys'
import { DesktopNotifications } from './DesktopNotifications'
import type { DesktopNotificationBatch } from '../lib/desktop'

test('only an enabled desktop bridge receives cached or newly fetched alerts, without marking inbox items read', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const delivered: DesktopNotificationBatch[] = []
  const batch: DesktopNotificationBatch = {
    userId: 'user',
    notifications: [
      { id: 'notification', title: 'Ready', body: 'Review', url: '/inbox', createdAt: new Date().toISOString() },
    ],
  }
  try {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => true,
      deliverNotifications: async (value) => {
        delivered.push(value)
      },
    }
    client.setQueryData(desktopQueryKeys.enabled(), true)
    client.setQueryData(desktopQueryKeys.notifications(), batch)
    const { root } = dom.createRoot()
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <DesktopNotifications />
        </QueryClientProvider>
      )
    )
    expect(delivered).toEqual([batch])
    await dom.act(async () => {
      client.setQueryData(desktopQueryKeys.enabled(), false)
      await client.invalidateQueries({ queryKey: desktopQueryKeys.enabled(), refetchType: 'none' })
    })
    await dom.act(async () => {
      client.setQueryData(desktopQueryKeys.notifications(), { ...batch, notifications: [] })
    })
    expect(delivered).toEqual([batch])
  } finally {
    await dom.cleanup()
    delete window.tauDesktopApp
    client.clear()
  }
})
