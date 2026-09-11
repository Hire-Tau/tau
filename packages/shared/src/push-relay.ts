import { z } from 'zod'

export const PUSH_RELAY_PROTOCOL = 1 as const
export const PUSH_RELAY_BASE_URL = 'https://hiretau.ai'
export const relayInstanceTokenPattern =
  /^tau_pri_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/
export const relayBindingTokenSchema = z.string().regex(/^tau_prd_[A-Za-z0-9_-]{43}$/)
export const apnsTokenSchema = z.string().regex(/^(?:[0-9a-f]{2}){16,256}$/i)
export const relayPairingSchema = z
  .object({
    instanceId: z.string().uuid(),
    deviceToken: apnsTokenSchema,
    environment: z.enum(['production', 'sandbox']),
  })
  .strict()
// No title/body, arbitrary aps keys or caller-chosen origin/URL. Generic alerts
// open an existing app pairing; data is fetched from that Core after opening.
export const relayRoutingSchema = z
  .object({
    squadId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    workStreamId: z.string().uuid().optional(),
    waitId: z.string().uuid().optional(),
    questionId: z.string().uuid().optional(),
    messageId: z.string().uuid().optional(),
    actionId: z.string().uuid().optional(),
  })
  .strict()
export const relaySendSchema = z
  .object({
    version: z.literal(PUSH_RELAY_PROTOCOL),
    bindingToken: relayBindingTokenSchema,
    eventId: z.string().uuid(),
    routing: relayRoutingSchema,
  })
  .strict()
export type RelayRouting = z.infer<typeof relayRoutingSchema>
export type RelaySend = z.infer<typeof relaySendSchema>

export const installationKeySchema = z.string().regex(/^[0-9a-f]{64}$/)
export const instanceEnrollmentSchema = z
  .object({ publicKey: installationKeySchema, label: z.string().trim().min(1).max(60) })
  .strict()
export const activationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('refresh'), activationId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal('bind'),
      activationId: z.string().uuid(),
      deviceToken: apnsTokenSchema,
      environment: z.enum(['sandbox', 'production']),
      bindingToken: relayBindingTokenSchema,
    })
    .strict(),
])
export const activationProofSchema = z
  .object({ challengeId: z.string().uuid(), signature: z.string().regex(/^[0-9a-f]{128}$/) })
  .strict()
export type ActivationOperation = { action: 'activate'; label: string } | ActivationAction
export function activationOperationPayload(operation: ActivationOperation): string {
  return JSON.stringify(
    operation.action === 'activate'
      ? [operation.action, operation.label]
      : operation.action === 'refresh'
        ? [operation.action, operation.activationId]
        : [
            operation.action,
            operation.activationId,
            operation.deviceToken,
            operation.environment,
            operation.bindingToken,
          ]
  )
}
export interface ActivationChallenge {
  operationDigest: string
  id: string
  instanceId: string
  origin: string
  nonce: string
  expiresAt: string
}
export interface InstanceProLease {
  activationId: string
  instanceId: string
  origin: string
  pro: true
  expiresAt: string
}
export function activationProofMessage(challenge: ActivationChallenge): string {
  return JSON.stringify([
    'tau-instance-pro-v1',
    challenge.id,
    challenge.instanceId,
    challenge.origin,
    challenge.nonce,
    challenge.expiresAt,
  ])
}
export type ActivationAction = z.infer<typeof activationActionSchema>
