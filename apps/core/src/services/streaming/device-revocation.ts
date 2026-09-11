import type { SSEStreamingApi } from 'hono/streaming'
import { deviceConnectionRegistry, type DeviceConnectionRegistry } from '../auth/device-connection-registry'
import type { AuthContext } from '../auth/resolve-token'

/** Run a public SSE callback under a revocable device-token lease. */
export async function withDeviceStreamRevocation<T>(
  auth: AuthContext,
  stream: SSEStreamingApi,
  callback: (signal: AbortSignal) => Promise<T>,
  registry: DeviceConnectionRegistry = deviceConnectionRegistry
): Promise<T | undefined> {
  const controller = new AbortController()
  if (!auth.deviceTokenId) return callback(controller.signal)

  const handle = await registry.register(auth.deviceTokenId, () => {
    controller.abort()
    stream.close()
  })
  if (!handle.isActive()) return undefined
  try {
    return await callback(controller.signal)
  } finally {
    handle.dispose()
  }
}
