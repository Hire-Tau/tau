import { describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DeviceConnectionRegistry } from '../auth/device-connection-registry'
import { withDeviceRevocation } from './device-revocation'

function fixture(lookup = async (ids: string[]) => new Set(ids)) {
  const deviceTokenId = randomUUID()
  const registry = new DeviceConnectionRegistry(lookup)
  const raw = { close: mock(() => {}) }
  const ws = { raw } as any
  const delegate = {
    onOpen: mock(async () => {}),
    onMessage: mock(() => {}),
    onClose: mock(() => {}),
    onError: mock(() => {}),
  }
  const handlers = withDeviceRevocation(
    { identity: { type: 'user', userId: randomUUID() }, deviceTokenId },
    delegate,
    registry
  )
  return { deviceTokenId, registry, raw, ws, delegate, handlers }
}

describe('withDeviceRevocation', () => {
  test('admits messages only after authoritative registration and async open', async () => {
    let release!: (ids: Set<string>) => void
    const lookup = new Promise<Set<string>>((resolve) => (release = resolve))
    const f = fixture(() => lookup)
    const opening = f.handlers.onOpen?.({} as any, f.ws)
    f.handlers.onMessage?.({ data: 'pending' } as any, f.ws)
    expect(f.delegate.onMessage).not.toHaveBeenCalled()
    release(new Set([f.deviceTokenId]))
    await opening
    f.handlers.onMessage?.({ data: 'active' } as any, f.ws)
    expect(f.delegate.onMessage).toHaveBeenCalledTimes(1)
  })

  test('disposes registration that resolves after the socket already closed', async () => {
    let release!: (ids: Set<string>) => void
    const lookup = new Promise<Set<string>>((resolve) => (release = resolve))
    const f = fixture(() => lookup)
    const opening = f.handlers.onOpen?.({} as any, f.ws)

    f.handlers.onClose?.({} as any, f.ws)
    release(new Set([f.deviceTokenId]))
    await opening

    expect(f.registry.connectionCount(f.deviceTokenId)).toBe(0)
    expect(f.delegate.onOpen).not.toHaveBeenCalled()
  })

  test('revocation closes generically and denies messages before onClose', async () => {
    const f = fixture()
    await f.handlers.onOpen?.({} as any, f.ws)
    f.registry.revoke(f.deviceTokenId)
    f.handlers.onMessage?.({ data: 'late' } as any, f.ws)
    expect(f.raw.close).toHaveBeenCalledWith(4401, 'Authentication revoked')
    expect(f.delegate.onMessage).not.toHaveBeenCalled()
    expect(f.delegate.onClose).toHaveBeenCalledTimes(1)
    f.handlers.onClose?.({} as any, f.ws)
    expect(f.delegate.onClose).toHaveBeenCalledTimes(1)
  })

  test('cleans up once when async delegate open rejects', async () => {
    const f = fixture()
    f.delegate.onOpen.mockImplementation(async () => {
      throw new Error('open failed')
    })

    await f.handlers.onOpen?.({} as any, f.ws)
    f.handlers.onClose?.({} as any, f.ws)

    expect(f.raw.close).toHaveBeenCalledWith(4401, 'Authentication revoked')
    expect(f.delegate.onClose).toHaveBeenCalledTimes(1)
    expect(f.registry.connectionCount(f.deviceTokenId)).toBe(0)
  })

  test('revoke wins while async delegate open is awaiting', async () => {
    let finishOpen!: () => void
    const openingDelegate = new Promise<void>((resolve) => (finishOpen = resolve))
    const f = fixture()
    f.delegate.onOpen.mockImplementation(() => openingDelegate)
    const opening = f.handlers.onOpen?.({} as any, f.ws)
    await new Promise((resolve) => queueMicrotask(resolve))

    f.registry.revoke(f.deviceTokenId)
    finishOpen()
    await opening
    f.handlers.onMessage?.({ data: 'late' } as any, f.ws)

    expect(f.delegate.onMessage).not.toHaveBeenCalled()
    expect(f.delegate.onClose).toHaveBeenCalledTimes(1)
  })

  test('lets an admitted async message finish but denies the next message after revoke', async () => {
    let finishMessage!: () => void
    const admitted = new Promise<void>((resolve) => (finishMessage = resolve))
    const f = fixture()
    f.delegate.onMessage.mockImplementation(() => admitted)
    await f.handlers.onOpen?.({} as any, f.ws)

    const inFlight = f.handlers.onMessage?.({ data: 'admitted' } as any, f.ws)
    f.registry.revoke(f.deviceTokenId)
    f.handlers.onMessage?.({ data: 'denied' } as any, f.ws)
    let settled = false
    void Promise.resolve(inFlight).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishMessage()
    await inFlight

    expect(settled).toBe(true)
    expect(f.delegate.onMessage).toHaveBeenCalledTimes(1)
  })

  test('error disposes and delegates cleanup only once', async () => {
    const f = fixture()
    await f.handlers.onOpen?.({} as any, f.ws)
    f.handlers.onError?.({} as any, f.ws)
    f.handlers.onClose?.({} as any, f.ws)

    expect(f.delegate.onError).toHaveBeenCalledTimes(1)
    expect(f.delegate.onClose).toHaveBeenCalledTimes(1)
    expect(f.registry.connectionCount(f.deviceTokenId)).toBe(0)
  })

  test('leaves non-device handlers unchanged', () => {
    const delegate = { onMessage: mock(() => {}) }
    expect(withDeviceRevocation({ identity: { type: 'legacy' }, deviceTokenId: null }, delegate as any)).toBe(delegate)
  })
})
