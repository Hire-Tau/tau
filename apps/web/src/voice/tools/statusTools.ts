import { resolveVoiceSquadId } from '../squadReferences'
import { getActiveExecution, getAgent } from '../../api/agents'
import { listAllWorkStreams, listSquadAgents, listSquads, listWorkStreams } from '../../api/squads'
import { selectWorkStreamPresentationState, type WorkStream } from '@tau/shared'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

export function voiceWorkStreamStatus(workStream: WorkStream) {
  return selectWorkStreamPresentationState(workStream)
}

export function createStatusTools(deps: {
  getAgent: typeof getAgent
  getActiveExecution: typeof getActiveExecution
  listSquads: typeof listSquads
  listAllWorkStreams: typeof listAllWorkStreams
  listSquadAgents: typeof listSquadAgents
  listWorkStreams: typeof listWorkStreams
}) {
  const getStatusTool: VoiceAssistantTool<VoiceToolExecutor> = {
    definition: {
      type: 'function',
      name: 'get_status',
      description:
        "Get the current status of the system, a specific squad, or a specific agent. Use to answer questions about what's happening.",
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['overview', 'squad', 'agent'],
            description: "'overview' for all squads, 'squad' for a specific squad's agents, 'agent' for one agent",
          },
          id: {
            type: 'string',
            description:
              'Full squad UUID or squad URL slug for squad scope; full agent ID for agent scope. Required except for overview.',
          },
        },
        required: ['scope'],
      },
    },
    async execute(args) {
      const { scope, id } = args as { scope: string; id?: string }
      switch (scope) {
        case 'overview': {
          const squads = await deps.listSquads('active')
          const streams = await deps.listAllWorkStreams()
          return {
            squads: squads.map((s) => ({
              id: s.id,
              name: s.name,
              purpose: s.purpose,
              status: s.status,
            })),
            activeWorkStreams: streams.filter((workStream) => voiceWorkStreamStatus(workStream) === 'in_progress')
              .length,
            totalWorkStreams: streams.length,
          }
        }
        case 'squad': {
          if (typeof id !== 'string' || !id.trim()) return { error: 'Squad ID or slug required' }
          const squadId = resolveVoiceSquadId(id, await deps.listSquads())
          if (!squadId)
            return { error: `Unknown or ambiguous squad reference: ${id}. Use a full squad ID from overview.` }
          const [agents, streams] = await Promise.all([deps.listSquadAgents(squadId), deps.listWorkStreams(squadId)])
          return {
            agents: agents.map((a) => ({
              id: a.id,
              type: a.agentTypeId,
              status: a.status,
            })),
            workStreams: streams.map((w) => ({
              id: w.id,
              title: w.title,
              status: voiceWorkStreamStatus(w),
            })),
          }
        }
        case 'agent': {
          if (typeof id !== 'string' || !id.trim()) return { error: 'Agent ID required' }
          const agent = await deps.getAgent(id)
          const exec = await deps.getActiveExecution(agent.id)
          return {
            id: agent.id,
            type: agent.agentTypeId,
            status: agent.status,
            execution: exec.active ? { status: exec.status } : null,
          }
        }
        default:
          return { error: `Unknown scope: ${scope}` }
      }
    },
  }

  return { getStatusTool, statusTools: [getStatusTool] }
}

export const { getStatusTool, statusTools } = createStatusTools({
  getAgent,
  getActiveExecution,
  listSquads,
  listAllWorkStreams,
  listSquadAgents,
  listWorkStreams,
})
