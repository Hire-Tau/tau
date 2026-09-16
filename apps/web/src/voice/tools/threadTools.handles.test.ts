import { expect, test } from 'bun:test'
import { createThreadTools } from './threadTools'

test('read_thread accepts an agent handle and reads the resolved agent', async () => {
  const ava = { id: 'aaaaaaaa-1111-4111-8111-111111111111', agentTypeId: 'engineer', status: 'idle' }
  const seen: string[] = []
  const { readThreadTool } = createThreadTools({
    getAgent: async (id: string) => {
      if (id !== ava.id) throw new Error('API error: 404: Agent not found')
      return ava as any
    },
    listAgents: async () => [ava] as any,
    getActiveExecution: async (id: string) => {
      seen.push(id)
      return { active: false } as any
    },
    getMessages: async (id: string) => {
      seen.push(id)
      return { messages: [] } as any
    },
    getMessage: async () => {
      throw new Error('getMessage should not be called')
    },
  })
  const result = (await readThreadTool.execute({ agentId: 'aaaaaaaa' }, {} as any)) as any
  expect(result.agent.id).toBe(ava.id)
  expect(seen.sort()).toEqual([ava.id, ava.id])
})
