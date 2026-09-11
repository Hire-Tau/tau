import { listen, notify } from '../../lib/infra/local-events'
export type DeviceTokenRevokedHandler = (deviceTokenId: string) => void
export interface DeviceTokenEventAdapter {
  publish(deviceTokenId: string): void | Promise<void>
  subscribe(
    handler: DeviceTokenRevokedHandler
  ): void | (() => void | Promise<void>) | Promise<() => void | Promise<void>>
}

export const DEVICE_TOKEN_REVOKED_CHANNEL = 'device_token_revoked'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const localHandlers = new Set<DeviceTokenRevokedHandler>()

export function isDeviceTokenId(payload: string): boolean {
  return UUID_PATTERN.test(payload)
}

/** Eager synchronous in-process event adapter. */
export const localDeviceTokenEvents: DeviceTokenEventAdapter = {
  publish(deviceTokenId) {
    for (const handler of localHandlers) handler(deviceTokenId)
  },
  subscribe(handler) {
    localHandlers.add(handler)
    return () => {
      localHandlers.delete(handler)
    }
  },
}

/** Authenticated API↔worker fast path; awaiting publish observes peer dispatch. */
export const crossProcessDeviceTokenEvents: DeviceTokenEventAdapter = {
  publish(deviceTokenId) {
    return notify(DEVICE_TOKEN_REVOKED_CHANNEL, deviceTokenId)
  },
  async subscribe(handler) {
    return listen(DEVICE_TOKEN_REVOKED_CHANNEL, (payload) => {
      if (isDeviceTokenId(payload)) handler(payload)
    })
  },
}

export function subscribeToLocalDeviceTokenRevocations(handler: DeviceTokenRevokedHandler): () => void {
  return localDeviceTokenEvents.subscribe(handler) as () => void
}

/**
 * Dispatch a committed revocation to local and peer listeners.
 *
 * Local handlers run synchronously and terminate same-process connections
 * before the best-effort authenticated peer attempt is awaited. Resolution
 * does not imply replica-wide broadcast, reader cancellation settlement, or
 * client EOF; durable registry revalidation remains the missed-event fallback.
 */
export async function publishDeviceTokenRevocation(deviceTokenId: string): Promise<void> {
  localDeviceTokenEvents.publish(deviceTokenId)
  await crossProcessDeviceTokenEvents.publish(deviceTokenId)
}
