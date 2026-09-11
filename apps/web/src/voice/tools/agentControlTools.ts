import { stopAgent } from '../../api/agents'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export const controlAgentTool: VoiceAssistantTool<VoiceToolExecutor> = {
  definition: {
    type: 'function',
    name: 'control_agent',
    description: 'Stop an agent.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID' },
        action: { type: 'string', enum: ['stop'], description: 'Action to take' },
      },
      required: ['agentId', 'action'],
    },
  },
  async execute(args) {
    const { agentId, action } = args as { agentId: string; action: string }
    if (action === 'stop') return await stopAgent(agentId)
    return { error: `Unknown action: ${action}` }
  },
}

export const agentControlTools = [controlAgentTool]
