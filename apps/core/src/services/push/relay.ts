import { getSecretStore } from '../secrets'
import { randomUUID } from 'node:crypto'
import {
  PUSH_RELAY_BASE_URL,
  relayInstanceTokenPattern,
  relayRoutingSchema,
  type RelayRouting,
} from '@tau/shared/push-relay'

/** Runtime-only credential; never a Secret Store value or squad environment input. */
export function pushRelayConfig(env?: NodeJS.ProcessEnv) {
  const token = (env ? env.TAU_PUSH_RELAY_TOKEN : getSecretStore().get('TAU_PUSH_RELAY_TOKEN'))?.trim()
  if (!token) return null
  const match = relayInstanceTokenPattern.exec(token)
  if (!match) throw new Error('TAU_PUSH_RELAY_TOKEN must be a push-only instance credential')
  return { token, instanceId: match[1], baseUrl: PUSH_RELAY_BASE_URL }
}

export async function sendRelayAlert(
  bindingToken: string,
  routing: Record<string, unknown>,
  deps: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>
    config?: ReturnType<typeof pushRelayConfig>
  } = {}
) {
  const config = deps.config === undefined ? pushRelayConfig() : deps.config
  if (!config) return { accepted: false, reason: 'not_configured' }
  const allowed: RelayRouting = {}
  for (const key of ['squadId', 'agentId', 'workStreamId', 'waitId', 'questionId', 'messageId', 'actionId'] as const) {
    if (typeof routing[key] === 'string') {
      const candidate = relayRoutingSchema.safeParse({ [key]: routing[key] })
      if (candidate.success) Object.assign(allowed, candidate.data)
    }
  }
  try {
    const response = await (deps.fetch ?? fetch)(`${config.baseUrl}/api/push-relay/send`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, bindingToken, eventId: randomUUID(), routing: allowed }),
    })
    // Never surface provider bodies/headers (or log fetch exceptions containing
    // the request). This path must not fall back to direct APNs on denial.
    if (!response.ok) {
      await response.body?.cancel()
      return { accepted: false, reason: response.status === 403 ? 'pro_required' : 'relay_unavailable' }
    }
    const body = (await response.json()) as { accepted?: boolean; reason?: string }
    return {
      accepted: body.accepted === true,
      reason:
        body.reason === 'device_unregistered' ? 'device_unregistered' : body.accepted ? undefined : 'relay_unavailable',
    }
  } catch {
    return { accepted: false, reason: 'relay_unavailable' }
  }
}

/** Human-user enrollment approval is forwarded with the scoped server credential. */
export async function enrollInstancePro(input: { publicKey: string; label: string }) {
  const config = pushRelayConfig()
  if (!config) throw new Error('Instance Pro is not configured on this server')
  const response = await fetch(`${config.baseUrl}/api/push-relay/enrollments`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('Cloud enrollment is unavailable')
  }
  return (await response.json()) as import('@tau/shared/push-relay').ActivationChallenge
}
