import { z } from 'zod'
import { OAUTH_BROKER_SCOPES } from '../oauth-broker/protocol'

export const INTEGRATION_RELAY_SCOPES = ['integrations.events:subscribe', 'integrations.events:consume'] as const
export const INSTANCE_INTEGRATION_SCOPES = [...OAUTH_BROKER_SCOPES, ...INTEGRATION_RELAY_SCOPES] as const
export type IntegrationRelayScope = (typeof INTEGRATION_RELAY_SCOPES)[number]
export const RELAY_MAX_PAYLOAD_BYTES = 1024 * 1024
export const RELAY_BATCH_SIZE = 10
export const RELAY_MAX_RESPONSE_BYTES = 12 * 1024 * 1024
export const RELAY_SUBSCRIPTION_TTL_MS = 24 * 60 * 60_000
export const RELAY_EVENT_TTL_MS = 72 * 60 * 60_000
export const RELAY_LEASE_MS = 120_000

export const githubRepositoryKey = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]!))
  .transform((value) => value.toLowerCase())
const connectionId = z.string().uuid()
const connectionRevision = z.string().uuid()
const accessToken = z.string().min(1).max(16_384)
export const relayStatusRequest = z.object({}).strict()
export const relayStatusResponse = z
  .object({
    enabled: z.boolean(),
    connections: z.array(z.object({ connectionId, connectionRevision }).strict()).max(100),
  })
  .strict()
export const relaySubscribeRequest = z
  .object({
    connectionId,
    connectionRevision,
    accessToken,
    repositories: z.array(githubRepositoryKey).min(1).max(100),
  })
  .strict()
export const relayUnsubscribeRequest = z.object({ connectionId, connectionRevision }).strict()
export const relaySuccessResponse = z.object({ ok: z.literal(true) }).strict()
export const relayPullRequest = z.object({ connectionId, connectionRevision, accessToken }).strict()
export const relayDelivery = z
  .object({
    id: z.string().uuid(),
    leaseToken: z.string().uuid(),
    connectionId,
    connectionRevision,
    deliveryId: z.string().min(1).max(100),
    resourceId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    resourceKey: githubRepositoryKey,
    eventType: z.string().regex(/^[a-z_]{1,64}$/),
    payload: z.record(z.unknown()),
  })
  .strict()
export const relayPullResponse = z.object({ deliveries: z.array(relayDelivery).max(RELAY_BATCH_SIZE) }).strict()
export const relayAckRequest = z
  .object({
    connectionId,
    connectionRevision,
    deliveries: z
      .array(z.object({ id: z.string().uuid(), leaseToken: z.string().uuid() }).strict())
      .max(RELAY_BATCH_SIZE),
  })
  .strict()
export type RelayDelivery = z.infer<typeof relayDelivery>
