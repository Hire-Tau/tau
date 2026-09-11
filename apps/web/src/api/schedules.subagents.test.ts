import { describe, expect, it } from 'bun:test'
import { createSchedulesApi } from './schedules'

describe('schedulesApi subagent filters', () => {
  it('serializes kind into the query string', async () => {
    const calls: string[] = []
    const schedulesApi = createSchedulesApi(async (path: string) => (calls.push(path), []) as never)
    await schedulesApi.list({ kind: 'subagent-watchdog' })
    expect(calls[0]).toContain('kind=subagent-watchdog')
  })

  it('serializes excludeKind into the query string', async () => {
    const calls: string[] = []
    const schedulesApi = createSchedulesApi(async (path: string) => (calls.push(path), []) as never)
    await schedulesApi.list({ excludeKind: 'subagent-watchdog' })
    expect(calls[0]).toContain('excludeKind=subagent-watchdog')
  })
})
