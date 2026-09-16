import { expect, mock, test } from 'bun:test'
import { createAssistantTools } from './assistantTools'

test('navigate resolves an agent handle to the unique live agent before offering its conversation', async () => {
  const morgan = {
    id: 'bbbbbbbb-2222-4222-8222-222222222222',
    squadId: 'squad',
    agentTypeId: 'manager',
    status: 'idle',
    metadata: { name: 'Morgan' },
  }
  const getAgent = mock(async (id: string) => {
    if (id !== morgan.id) throw new Error('API error: 404: Agent not found')
    return morgan as any
  })
  const listAgents = mock(async () => [morgan] as any)
  const tools = createAssistantTools({ getAgent, listAgents })
  const navigate = tools.find((tool) => tool.definition.name === 'navigate')!
  const offered = (await navigate.execute({ agentId: 'bbbbbbbb' }, { navigate() {} })) as any
  expect(offered.conversation).toMatchObject({ agentId: morgan.id, label: 'Morgan' })
  expect(listAgents).toHaveBeenCalledTimes(1)
})
