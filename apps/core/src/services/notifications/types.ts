/**
 * Context for matching notification rules.
 */
export interface EventContext {
  event: string
}

export interface NotificationRule {
  /** Stable identifier for YAML/template override tracking. Defaults to event when omitted. */
  id?: string
  event?: string
  /** Match conditions on event data (dot notation supported) */
  match?: Record<string, unknown>
  /** Channels to send to (multi-channel support) */
  channels: string[]
}

export interface ChannelConfig {
  enabled: boolean
}

export interface NotificationConfig {
  rules: NotificationRule[]
  channels: Record<string, ChannelConfig>
}

/**
 * Squad notification config (stored in squad.metadata.notifications)
 */
export interface SquadNotificationConfig {
  discord?: { instanceId: string; channelId: string }
  slack?: { instanceId: string; channelId: string }
  telegram?: { instanceId: string; channelId: string }
}
