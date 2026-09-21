import type { Agent } from '@tau/shared'

export { parseEntityReference, type EntityReference } from '@tau/shared'

export function agentChatPath(agent: Pick<Agent, 'id' | 'squadId'>): string {
  return agent.squadId
    ? `/squads/${encodeURIComponent(agent.squadId)}/agents?agent=${encodeURIComponent(agent.id)}`
    : `/chat/${encodeURIComponent(agent.id)}`
}
