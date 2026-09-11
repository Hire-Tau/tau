import { afterEach, describe, test, expect, beforeEach, mock } from 'bun:test'
import { WebSocketManager } from './manager'
import { setupEventBridge } from './bridge'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { cleanupTestRbac, createTestAdmin } from '../../test-utils'
import { createDeviceToken, revokeDeviceToken } from '../auth/device-tokens'
import { createWsTicket, consumeWsTicket } from '../auth/ws-ticket'
import { resolveTokenContext } from '../auth/resolve-token'
import { app } from '../../index'
import { websocket } from 'hono/bun'
import { withDeviceRevocation } from './device-revocation'
import { db } from '../../db'
import { agents, users } from '../../db/schema'
import { eq } from 'drizzle-orm'

const REVOCATION_PREFIX = 'ws-revocation-integration'
const privateAgentId = '11111111-1111-4111-8111-111111111111'
const ownerUserId = '22222222-2222-4222-8222-222222222222'

async function withRbacCleanup<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } finally {
    await cleanupTestRbac(REVOCATION_PREFIX)
  }
}

afterEach(async () => {
  await db.delete(agents).where(eq(agents.id, privateAgentId))
  await db.delete(users).where(eq(users.id, ownerUserId))
})

describe('WebSocket Integration', () => {
  let manager: WebSocketManager
  let receivedMessages: string[]
  let mockWs: any
  let removeBridge: () => void

  beforeEach(() => {
    manager = new WebSocketManager()
    eventEmitter.removeAllListeners()
    removeBridge = setupEventBridge(manager)

    receivedMessages = []
    mockWs = {
      send: (data: string) => {
        receivedMessages.push(data)
      },
    }
  })

  afterEach(() => removeBridge())

  test('production /ws upgrade preserves direct and ticket device provenance through committed revoke', () =>
    withRbacCleanup(async () => {
      const user = await createTestAdmin({ prefix: REVOCATION_PREFIX, canonicalAdmin: true })
      const device = await createDeviceToken({ userId: user.id, name: 'Production WS', platform: 'cli' })
      const ticket = await createWsTicket(user.id, device.id)
      const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
      const open = (query: string) =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(`ws://localhost:${server.port}/ws?${query}`)
          socket.addEventListener('open', () => resolve(socket), { once: true })
          socket.addEventListener('error', () => reject(new Error('websocket failed to open')), { once: true })
        })
      const direct = await open(`token=${encodeURIComponent(device.token)}`)
      const ticketSocket = await open(`ticket=${encodeURIComponent(ticket)}`)
      const session = await open(`token=${encodeURIComponent(user.token)}`)
      const closed = (socket: WebSocket) =>
        new Promise<CloseEvent>((resolve) =>
          socket.addEventListener('close', (event) => resolve(event), { once: true })
        )
      const directClosed = closed(direct)
      const ticketClosed = closed(ticketSocket)

      await revokeDeviceToken(user.id, device.id)

      expect((await directClosed).code).toBe(4401)
      expect((await ticketClosed).code).toBe(4401)
      expect(session.readyState).toBe(WebSocket.OPEN)
      const sessionClosed = closed(session)
      session.close()
      await sessionClosed
      void server.stop(true)
    }))

  test('committed revoke closes all sockets for one device while other device and session sockets survive', () =>
    withRbacCleanup(async () => {
      const user = await createTestAdmin({ prefix: REVOCATION_PREFIX, canonicalAdmin: true })
      const deviceA = await createDeviceToken({ userId: user.id, name: 'A', platform: 'cli' })
      const deviceB = await createDeviceToken({ userId: user.id, name: 'B', platform: 'cli' })
      const closeA1 = mock(() => {})
      const closeA2 = mock(() => {})
      const closeB = mock(() => {})
      const closeSession = mock(() => {})
      const delegate = { onOpen() {}, onMessage() {}, onClose() {}, onError() {} }
      const makeSocket = async (deviceTokenId: string | null, close: () => void) => {
        const handlers = withDeviceRevocation(
          { identity: { type: 'user', userId: user.id }, deviceTokenId },
          delegate as any
        )
        await handlers.onOpen?.({} as any, { raw: { close } } as any)
        return handlers
      }
      const outstandingTicket = await createWsTicket(user.id, deviceA.id)
      await makeSocket(deviceA.id, closeA1)
      await makeSocket(deviceA.id, closeA2)
      await makeSocket(deviceB.id, closeB)
      await makeSocket(null, closeSession)

      await revokeDeviceToken(user.id, deviceA.id)

      expect(closeA1).toHaveBeenCalledWith(4401, 'Authentication revoked')
      expect(closeA2).toHaveBeenCalledWith(4401, 'Authentication revoked')
      expect(closeB).not.toHaveBeenCalled()
      expect(closeSession).not.toHaveBeenCalled()
      expect(await resolveTokenContext(deviceA.token)).toBeNull()
      expect(await consumeWsTicket(outstandingTicket)).toBeNull()

      const reconnect = await makeSocket(
        deviceA.id,
        mock(() => {})
      )
      const lateMessage = mock(() => {})
      ;(delegate as any).onMessage = lateMessage
      reconnect.onMessage?.({ data: 'late' } as any, {} as any)
      expect(lateMessage).not.toHaveBeenCalled()
    }))

  test('message events reach a private owner on collection and instance topics only', async () => {
    await db.insert(users).values({ id: ownerUserId, email: 'ws-integration-owner@example.com' })
    await db.insert(agents).values({ id: privateAgentId, agentTypeId: 'system-manager', ownerUserId })
    const foreignMessages: string[] = []
    const foreignWs = { send: (data: string) => foreignMessages.push(data) } as any
    const ownerClient = manager.addClient(mockWs, { type: 'user', userId: ownerUserId })
    const foreignClient = manager.addClient(foreignWs, { type: 'legacy' })
    await manager.subscribe(ownerClient, `agents:${privateAgentId}`)
    await manager.subscribe(ownerClient, 'agents')
    await manager.subscribe(foreignClient, 'agents')
    expect(receivedMessages.map((message) => JSON.parse(message))).toEqual([
      { type: 'subscribed', topic: `agents:${privateAgentId}` },
      { type: 'subscribed', topic: 'agents' },
    ])
    receivedMessages = []
    foreignMessages.length = 0
    const framesReceived = Promise.withResolvers<void>()
    const originalSend = mockWs.send
    mockWs.send = (data: string) => {
      originalSend(data)
      if (receivedMessages.length === 2) framesReceived.resolve()
    }

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      eventEmitter.emit('message.created', { messageId: 'msg-1', agentId: privateAgentId })
      await Promise.race([
        framesReceived.promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Timed out waiting for 2 owner frames; received ${receivedMessages.length}`)),
            2_000
          )
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    expect(receivedMessages).toHaveLength(2)
    expect(receivedMessages.map((message) => JSON.parse(message).topic).sort()).toEqual([
      'agents',
      `agents:${privateAgentId}`,
    ])
    expect(
      receivedMessages.every((message) => {
        const frame = JSON.parse(message)
        return (
          frame.event === 'message.created' && frame.data.agentId === privateAgentId && frame.data.messageId === 'msg-1'
        )
      })
    ).toBe(true)
    expect(foreignMessages).toHaveLength(0)
  })
})
