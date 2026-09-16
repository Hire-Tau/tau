import { expect, test } from 'bun:test'
import { createAgentMessagingTools } from './agentMessagingTools'

const xenon = { id: 'df4ab896-96d5-4d74-9858-40e8a330037e', agentTypeId: 'manager', squadId: 'squad-1', status: 'idle' }
const tern = { id: 'fd39cd21-61d3-4c4b-b8f1-3bca5fed4ae4', agentTypeId: 'manager', squadId: 'squad-2', status: 'idle' }

function tools(sent: string[]) {
  return createAgentMessagingTools({
    getAgent: async (id: string) => {
      const found = [xenon, tern].find((agent) => agent.id === id)
      if (!found) throw new Error('API error: 404: Agent not found')
      return found as any
    },
    listAgents: async () => [xenon, tern] as any,
    sendAgentMessage: async (agentId: string) => {
      sent.push(agentId)
      return { success: true, status: 'queued' } as any
    },
    stopAgent: async () => ({ success: true }),
    sendInboxMessage: async () => {
      throw new Error('not used')
    },
  })
}

test('message_agent resolves a spliced id to the unique live agent with that first segment before sending', async () => {
  const sent: string[] = []
  const { directMessageAgentTool } = tools(sent)
  const result = await directMessageAgentTool.execute(
    { agentId: 'df4ab896-61d3-4c4b-b8f1-3bca5fed4ae4', content: 'Hi Xenon' },
    {}
  )
  expect(result).toEqual({ ok: true, agentStatus: 'queued' })
  expect(sent).toEqual([xenon.id])
})

test('message_agent never guesses: an unknown handle fails without sending', async () => {
  const sent: string[] = []
  const { directMessageAgentTool } = tools(sent)
  await expect(directMessageAgentTool.execute({ agentId: '00000000', content: 'x' }, {})).rejects.toThrow(
    'Unknown agent'
  )
  expect(sent).toEqual([])
})
