export interface DesktopNotification {
  id: string
  createdAt: string
  title: string
  body: string
  url: string
}
export interface DesktopNotificationBatch {
  userId: string
  notifications: DesktopNotification[]
}
interface DesktopBridge {
  version: 1
  notificationsEnabled(): Promise<boolean>
  deliverNotifications(batch: DesktopNotificationBatch): Promise<void>
}
declare global {
  interface Window {
    tauDesktopApp?: DesktopBridge
  }
}
export function desktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined' && window.tauDesktopApp?.version === 1 ? window.tauDesktopApp : undefined
}
