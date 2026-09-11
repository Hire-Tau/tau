import { describe, expect, test } from 'bun:test'
import { createSystemLogsWebSocketHandlers, getSystemLogsParams } from './system-logs'
import { SystemLogProviderError, type SystemLogProvider } from '../system-logs/types'

function ctx(url: string) {
  return { req: { url } } as any
}

describe('getSystemLogsParams', () => {
  test('defaults to all components with follow=true', () => {
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs'))).toEqual({
      components: ['api', 'worker'],
      tailLines: 500,
      follow: true,
    })
  })

  test('accepts allowlisted components', () => {
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?component=api'))!.components).toEqual(['api'])
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?component=worker'))!.components).toEqual(['worker'])
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?component=all'))!.components).toEqual(['api', 'worker'])
  })

  test('rejects invalid components and path-like values', () => {
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?component=foo'))).toBeNull()
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?component=../../etc/passwd'))).toBeNull()
  })

  test('parses and clamps tailLines', () => {
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?tailLines=99999'))!.tailLines).toBe(5000)
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?tailLines=0'))!.tailLines).toBe(1)
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?tailLines=250'))!.tailLines).toBe(250)
  })

  test('defaults invalid tailLines to 500', () => {
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs'))!.tailLines).toBe(500)
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?tailLines=abc'))!.tailLines).toBe(500)
  })

  test('parses follow query values', () => {
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs'))!.follow).toBe(true)
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?follow=true'))!.follow).toBe(true)
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?follow=false'))!.follow).toBe(false)
    expect(getSystemLogsParams(ctx('http://x/ws/system/logs?follow=0'))!.follow).toBe(false)
  })
})

test('preserves a synchronous typed provider failure', async () => {
  const sent: string[] = []
  const closes: Array<[number, string]> = []
  const provider: SystemLogProvider = {
    name: 'file',
    stream() {
      throw new SystemLogProviderError('TARGET_NOT_FOUND', 'A configured system log file was not found.')
    },
  }
  const handlers = createSystemLogsWebSocketHandlers(
    { components: ['api'], tailLines: 10, follow: true },
    () => provider
  )
  const ws = {
    raw: {
      send(value: string) {
        sent.push(value)
      },
      close(code: number, reason: string) {
        closes.push([code, reason])
      },
    },
  }
  await handlers.onOpen?.({} as never, ws as never)
  const error = sent.map((value) => JSON.parse(value)).find((message) => message.type === 'error')
  expect(error).toEqual({
    type: 'error',
    code: 'TARGET_NOT_FOUND',
    message: 'A configured system log file was not found.',
  })
  expect(closes).toEqual([[4500, 'Failed to start log stream']])
})
