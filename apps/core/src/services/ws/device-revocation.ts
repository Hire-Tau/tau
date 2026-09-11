import type { WSEvents } from 'hono/ws'
import type { AuthContext } from '../auth/resolve-token'
import {
  deviceConnectionRegistry,
  type DeviceConnectionRegistry,
  type DeviceConnectionHandle,
} from '../auth/device-connection-registry'

const REVOKED_CODE = 4401
const REVOKED_REASON = 'Authentication revoked'

type AdmissionState = 'pending' | 'opening' | 'active' | 'closed'

/** Guard a WebSocket handler set with device-credential admission and revocation. */
export function withDeviceRevocation<T extends { close(code?: number, reason?: string): void }>(
  auth: AuthContext,
  delegate: WSEvents<T>,
  registry: DeviceConnectionRegistry = deviceConnectionRegistry
): WSEvents<T> {
  if (!auth.deviceTokenId) return delegate

  let state: AdmissionState = 'pending'
  let handle: DeviceConnectionHandle | null = null
  let delegateStarted = false
  let cleaned = false
  let openArgs: Parameters<NonNullable<WSEvents<T>['onOpen']>> | null = null

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    handle?.dispose()
    if (delegateStarted && openArgs) delegate.onClose?.({} as CloseEvent, openArgs[1])
  }
  const terminate = () => {
    if (state === 'closed') return
    state = 'closed'
    openArgs?.[1].raw?.close(REVOKED_CODE, REVOKED_REASON)
    cleanup()
  }

  return {
    async onOpen(event, ws) {
      openArgs = [event, ws]
      handle = await registry.register(auth.deviceTokenId!, terminate)
      if (state === 'closed') {
        handle.dispose()
        return
      }
      if (!handle.isActive()) return
      state = 'opening'
      delegateStarted = true
      try {
        await delegate.onOpen?.(event, ws)
        if (state === 'opening' && handle.isActive()) state = 'active'
      } catch {
        terminate()
      }
    },
    onMessage(event, ws) {
      if (state !== 'active' || !handle?.isActive()) return
      return delegate.onMessage?.(event, ws)
    },
    onClose(event, ws) {
      if (state === 'closed') return
      state = 'closed'
      handle?.dispose()
      if (!cleaned && delegateStarted) {
        cleaned = true
        return delegate.onClose?.(event, ws)
      }
    },
    onError(event, ws) {
      if (state === 'closed') return
      delegate.onError?.(event, ws)
      state = 'closed'
      cleanup()
    },
  }
}
