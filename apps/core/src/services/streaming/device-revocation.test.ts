import { describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DeviceConnectionRegistry } from '../auth/device-connection-registry'
import { withDeviceStreamRevocation } from './device-revocation'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('withDeviceStreamRevocation', () => {
  test('aborts and closes an active stream when its device is revoked', async () => {
    const deviceTokenId = randomUUID()
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids))
    const stream = { close: mock(() => {}) } as any
    let signal!: AbortSignal
    let release!: () => void
    let started!: () => void
    const work = new Promise<void>((resolve) => (release = resolve))
    const callbackStarted = new Promise<void>((resolve) => (started = resolve))
    const running = withDeviceStreamRevocation(
      { identity: { type: 'user', userId: randomUUID() }, deviceTokenId },
      stream,
      async (value) => {
        signal = value
        started()
        await work
      },
      registry
    )
    await callbackStarted

    registry.revoke(deviceTokenId)

    expect(signal.aborted).toBe(true)
    expect(stream.close).toHaveBeenCalledTimes(1)
    expect(registry.connectionCount(deviceTokenId)).toBe(0)
    let settled = false
    void running.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await running
    expect(settled).toBe(true)
  })

  test('a revoke during authoritative lookup prevents callback admission', async () => {
    const lookup = deferred<Set<string>>()
    const deviceTokenId = randomUUID()
    const registry = new DeviceConnectionRegistry(() => lookup.promise)
    const callback = mock(async () => {})
    const stream = { close: mock(() => {}) } as any
    const running = withDeviceStreamRevocation(
      { identity: { type: 'user', userId: randomUUID() }, deviceTokenId },
      stream,
      callback,
      registry
    )

    expect(registry.connectionCount(deviceTokenId)).toBe(1)
    registry.revoke(deviceTokenId)
    lookup.resolve(new Set([deviceTokenId]))
    await running

    expect(callback).not.toHaveBeenCalled()
    expect(stream.close).toHaveBeenCalledTimes(1)
    expect(registry.connectionCount(deviceTokenId)).toBe(0)
  })

  test('does not invoke the callback when admission is denied', async () => {
    const callback = mock(async () => {})
    const stream = { close: mock(() => {}) } as any
    const registry = new DeviceConnectionRegistry(async () => new Set())
    const deviceTokenId = randomUUID()

    await withDeviceStreamRevocation(
      { identity: { type: 'user', userId: randomUUID() }, deviceTokenId },
      stream,
      callback,
      registry
    )

    expect(callback).not.toHaveBeenCalled()
    expect(stream.close).toHaveBeenCalledTimes(1)
    expect(registry.connectionCount(deviceTokenId)).toBe(0)
  })

  test('disposes the lease after success and callback failure', async () => {
    const deviceTokenId = randomUUID()
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids))
    const auth = { identity: { type: 'user' as const, userId: randomUUID() }, deviceTokenId }
    const stream = { close: mock(() => {}) } as any

    await withDeviceStreamRevocation(auth, stream, async () => 'done', registry)
    expect(registry.connectionCount(deviceTokenId)).toBe(0)

    await expect(
      withDeviceStreamRevocation(
        auth,
        stream,
        async () => {
          throw new Error('stream failed')
        },
        registry
      )
    ).rejects.toThrow('stream failed')
    expect(registry.connectionCount(deviceTokenId)).toBe(0)
  })

  test('removes a completed lease before a later revoke', async () => {
    const deviceTokenId = randomUUID()
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids))
    const stream = { close: mock(() => {}) } as any

    await withDeviceStreamRevocation(
      { identity: { type: 'user', userId: randomUUID() }, deviceTokenId },
      stream,
      async () => {},
      registry
    )
    expect(registry.connectionCount(deviceTokenId)).toBe(0)

    registry.revoke(deviceTokenId)
    expect(stream.close).not.toHaveBeenCalled()
  })

  test('another device revoke does not affect a non-device session stream', async () => {
    const otherDeviceId = randomUUID()
    const registry = new DeviceConnectionRegistry(async (ids) => new Set(ids))
    const stream = { close: mock(() => {}) } as any
    const otherClose = mock(() => {})
    await registry.register(otherDeviceId, otherClose)
    let signal!: AbortSignal
    const callback = mock(async (value: AbortSignal) => {
      signal = value
    })

    await withDeviceStreamRevocation({ identity: { type: 'legacy' }, deviceTokenId: null }, stream, callback, registry)
    registry.revoke(otherDeviceId)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(false)
    expect(stream.close).not.toHaveBeenCalled()
    expect(otherClose).toHaveBeenCalledTimes(1)
    expect(registry.connectionCount(otherDeviceId)).toBe(0)
  })
})
