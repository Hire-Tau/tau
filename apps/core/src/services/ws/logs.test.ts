import { describe, expect, mock, test } from 'bun:test'
import { createLogsWebSocketHandlers, getLogsParams } from './logs'

function ctx(url: string, sandboxId?: string) {
  return {
    req: {
      url,
      param: (k: string) => (k === 'sandboxId' ? sandboxId : undefined),
    },
  } as any
}

describe('createLogsWebSocketHandlers', () => {
  test('does not start a stream when the socket closes during squad lookup', async () => {
    let resolveSquad!: (value: object) => void
    const findSquad = mock(() => new Promise<object>((resolve) => (resolveSquad = resolve)))
    const streamLogs = mock(() => ({ cancel: mock(() => {}) }))
    const handlers = createLogsWebSocketHandlers(
      { sandboxId: 'squad_a', tailLines: 10, previous: false },
      { findSquad, getManager: () => ({ streamLogs }) }
    )
    const raw = { send: mock(() => {}), close: mock(() => {}) }
    const ws = { raw } as any

    const opening = handlers.onOpen!(new Event('open'), ws as never)
    handlers.onClose!(new CloseEvent('close'), ws as never)
    resolveSquad({ id: 'a' })
    await opening

    expect(streamLogs).not.toHaveBeenCalled()
  })

  test('cancels a stream returned after a reentrant close', async () => {
    const cancel = mock(() => {})
    const raw = { send: mock(() => {}), close: mock(() => {}) }
    const ws = { raw } as any
    const streamLogs = mock(() => {
      handlers.onClose!(new CloseEvent('close'), ws as never)
      return { cancel }
    })
    const handlers = createLogsWebSocketHandlers(
      { sandboxId: 'squad_a', tailLines: 10, previous: false },
      { findSquad: async () => ({ id: 'a' }), getManager: () => ({ streamLogs }) }
    )

    await handlers.onOpen!(new Event('open'), ws as never)

    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('getLogsParams', () => {
  test('returns null without a sandboxId path param', () => {
    expect(getLogsParams(ctx('http://x/ws/sandbox//logs'))).toBeNull()
  })
  test('defaults tailLines to 500 and previous to false', () => {
    expect(getLogsParams(ctx('http://x/ws/sandbox/squad_a/logs', 'squad_a'))).toEqual({
      sandboxId: 'squad_a',
      tailLines: 500,
      previous: false,
    })
  })
  test('parses and clamps tailLines and reads previous=true', () => {
    expect(getLogsParams(ctx('http://x/ws/sandbox/squad_a/logs?tailLines=99999&previous=true', 'squad_a'))).toEqual({
      sandboxId: 'squad_a',
      tailLines: 5000,
      previous: true,
    })
    expect(getLogsParams(ctx('http://x/ws/sandbox/squad_a/logs?tailLines=0', 'squad_a'))!.tailLines).toBe(1)
  })
})
