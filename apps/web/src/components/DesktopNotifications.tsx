import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { desktopBridge } from '../lib/desktop'

/** Mounted only inside the signed-in shell. The native window stays alive when closed/minimized. */
export function DesktopNotifications() {
  const bridge = desktopBridge()
  const { data: enabled = false } = useQuery({
    ...queries.desktop.enabled(),
    enabled: !!bridge,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  })
  const { data, dataUpdatedAt } = useQuery({
    ...queries.desktop.notifications(),
    enabled: !!bridge && enabled,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  })
  useEffect(() => {
    if (enabled && data && bridge) void bridge.deliverNotifications(data).catch(() => {})
  }, [enabled, data, dataUpdatedAt, bridge])
  return null
}
