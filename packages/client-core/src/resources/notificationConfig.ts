import type { Transport } from '../transport'

/** The caller's own notification preferences (self-service). */
export interface MyNotificationPreferences {
  pushEnabled: boolean
  mutedEvents: string[]
}

export function notificationConfigResource(t: Transport) {
  return {
    getMine: (): Promise<MyNotificationPreferences> => t.request('/notification-config/me'),
    updateMine: (input: Partial<MyNotificationPreferences>): Promise<MyNotificationPreferences> =>
      t.request('/notification-config/me', { method: 'PUT', body: input }),
  }
}
