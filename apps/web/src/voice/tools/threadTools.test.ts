import { expect, test } from 'bun:test'
import { createThreadTools } from './threadTools'

function makeMessage(overrides: Partial<any> = {}) {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'hello',
    pending: false,
    createdAt: '2026-01-01',
    metadata: {},
    ...overrides,
  }
}

function unused(name: string) {
  return async () => {
    throw new Error(`${name} should not be called`)
  }
}

test('read_thread without messageId builds agent status and execution alongside the mapped messages', async () => {
  const getAgent = async (agentId: string) => ({ id: agentId, agentTypeId: 'engineer', status: 'active' }) as any
  const getActiveExecution = async () => ({ active: false }) as any
  const getMessages = async () => ({ messages: [makeMessage()] }) as any
  const { readThreadTool } = createThreadTools({
    getAgent,
    getActiveExecution,
    getMessages,
    getMessage: unused('getMessage'),
  })

  const result = (await readThreadTool.execute({ agentId: 'a1' }, {})) as any

  expect(result.agent).toEqual({ id: 'a1', type: 'engineer', status: 'active', execution: null })
  expect(result.messages).toEqual([
    { id: 'm1', role: 'assistant', content: 'hello', blockCount: 0, pending: false, createdAt: '2026-01-01' },
  ])
})

test('read_thread reports the active execution status when the agent is running', async () => {
  const getAgent = async (agentId: string) => ({ id: agentId, agentTypeId: 'engineer', status: 'active' }) as any
  const getActiveExecution = async () => ({ active: true, status: 'running' }) as any
  const getMessages = async () => ({ messages: [] }) as any
  const { readThreadTool } = createThreadTools({
    getAgent,
    getActiveExecution,
    getMessages,
    getMessage: unused('getMessage'),
  })

  const result = (await readThreadTool.execute({ agentId: 'a1' }, {})) as any

  expect(result.agent.execution).toEqual({ status: 'running' })
})

test('read_thread with messageId paginates the full message content by offset and limit', async () => {
  const content = 'x'.repeat(1200)
  const getMessage = async () => ({ id: 'm1', content, metadata: {} }) as any
  const { readThreadTool } = createThreadTools({
    getAgent: unused('getAgent'),
    getActiveExecution: unused('getActiveExecution'),
    getMessages: unused('getMessages'),
    getMessage,
  })

  const first = (await readThreadTool.execute({ agentId: 'a1', messageId: 'm1', limit: 500 }, {})) as any
  expect(first).toEqual({ content: content.slice(0, 500), offset: 0, length: 1200, hasMore: true, nextOffset: 500 })

  const second = (await readThreadTool.execute(
    { agentId: 'a1', messageId: 'm1', offset: 500, limit: 500 },
    {}
  )) as any
  expect(second).toEqual({
    content: content.slice(500, 1000),
    offset: 500,
    length: 1200,
    hasMore: true,
    nextOffset: 1000,
  })

  const last = (await readThreadTool.execute(
    { agentId: 'a1', messageId: 'm1', offset: 1000, limit: 500 },
    {}
  )) as any
  expect(last).toEqual({ content: content.slice(1000), offset: 1000, length: 1200, hasMore: false })
})
