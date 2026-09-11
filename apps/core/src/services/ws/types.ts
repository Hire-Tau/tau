import type { Topic } from '@tau/shared'
export { isValidTopic } from '@tau/shared'
export type { Topic, CollectionTopic, InstanceTopic } from '@tau/shared'

// Client -> Server messages
export type ClientMessage = { type: 'subscribe'; topic: string } | { type: 'unsubscribe'; topic: string }

// Server -> Client messages
export type ServerMessage =
  | { type: 'subscribed'; topic: Topic }
  | { type: 'unsubscribed'; topic: Topic }
  | { type: 'event'; topic: Topic; event: string; data: unknown }
  | { type: 'error'; message: string; code?: 'FORBIDDEN_TOPIC'; topic?: Topic }
