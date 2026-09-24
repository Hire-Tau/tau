import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { desktopBridge } from '../lib/desktop'

/** Mounted only inside the signed-in shell. The native window stays alive when closed/minimized. */
export function DesktopNotifications() {
  const bridge = desktopBridge()
  // When the desktop shell already polls for us (e.g. a background window kept
  // alive independent of this page), the web app must not duplicate the poll.
  const polledByShell = bridge?.notificationsPolledByShell === true
  const { data: enabled = false } = useQuery({
    ...queries.desktop.enabled(),
    enabled: !!bridge && !polledByShell,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  })
  const { data, dataUpdatedAt } = useQuery({
    ...queries.desktop.notifications(),
    enabled: !!bridge && enabled && !polledByShell,
    refetchInterval: 10000,
    refetchIntervalInBackground: true,
  })
  useEffect(() => {
    if (enabled && data && bridge) void bridge.deliverNotifications(data).catch(() => {})
  }, [enabled, data, dataUpdatedAt, bridge])
  return null
}
