import { describe, expect, test } from 'bun:test'
import type { WorkStream } from '@tau/shared'
import { voiceWorkStreamStatus } from './statusTools'

function stream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: 'squad-1',
    title: 'Status voice fixture',
    description: '',
    status: 'active',
    derivedState: 'in_progress',
    priority: 'normal',
    agentIds: [],
    dependsOn: [],
    metadata: {},
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  } as WorkStream
}

describe('voiceWorkStreamStatus', () => {
  test('explicit empty waits override stale wait-derived state', () => {
    expect(voiceWorkStreamStatus(stream({ status: 'queued', derivedState: 'in_review', openWaits: [] }))).toBe('queued')
  })

  test('uses shared wait precedence regardless of input order', () => {
    const workStream = stream({
      openWaits: [{ type: 'manual' }, { type: 'dependency' }, { type: 'question' }, { type: 'review' }] as NonNullable<
        WorkStream['openWaits']
      >,
    })
    expect(voiceWorkStreamStatus(workStream)).toBe('in_review')
  })
})

describe('squad status references', () => {
  test('resolves the route slug before fetching squad resources', async () => {
    const { createStatusTools } = await import('./statusTools')
    const calls: string[] = []
    const squadId = '11111111-1111-1111-1111-111111111111'
    const { getStatusTool } = createStatusTools({
      listSquads: async () => [{ id: squadId, name: 'Tau', createdAt: '2026-01-01' }] as any,
      listSquadAgents: async (id) => {
        calls.push(id)
        return []
      },
      listWorkStreams: async (id) => {
        calls.push(id)
        return []
      },
      listAllWorkStreams: async () => [],
      getAgent: async () => {
        throw new Error('Unexpected agent request')
      },
      getActiveExecution: async () => {
        throw new Error('Unexpected execution request')
      },
    })
    expect(await getStatusTool.execute({ scope: 'squad', id: 'tau' }, { navigate() {} })).toEqual({
      agents: [],
      workStreams: [],
    })
    expect(calls).toEqual([squadId, squadId])
    calls.length = 0
    expect(await getStatusTool.execute({ scope: 'squad', id: 'missing' }, { navigate() {} })).toHaveProperty('error')
    expect(calls).toEqual([])
  })
})
