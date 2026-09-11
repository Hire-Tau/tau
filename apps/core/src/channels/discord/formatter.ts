import type { NotificationEvent } from '../provider'

const COLORS = {
  'workStream.blocked': 0xe74c3c, // red
  'workStream.review': 0xf39c12, // orange
  'workStream.done': 0x2ecc71, // green
  'workStream.canceled': 0x95a5a6, // gray
  'inbox.messageReceived': 0x3498db, // blue
  default: 0x3498db,
} as const

export function formatNotification(event: NotificationEvent) {
  const color = COLORS[event.type as keyof typeof COLORS] ?? COLORS.default

  return {
    embeds: [
      {
        title: event.title,
        description: event.body,
        color,
        url: event.url,
        timestamp: event.timestamp.toISOString(),
        footer: event.squadName ? { text: event.squadName } : undefined,
      },
    ],
  }
}
