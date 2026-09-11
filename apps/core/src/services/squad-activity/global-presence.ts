import { workStreamNeedsHumanAttention, type GlobalActivityPresence } from '@tau/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, workStreams } from '../../db/schema'
import type { Identity } from '../rbac'
import { computeDerivedStates } from '../work-streams/derived-state'
import { resolveGlobalActivityAccess } from './access'

/**
 * Build the global activity presence strip from only the squads and resource
 * types the authenticated identity may read. Callers supply no squad ids: the
 * same per-squad resolver as the global activity feed is authoritative here.
 */
export async function projectGlobalActivityPresence(identity: Identity): Promise<GlobalActivityPresence> {
  const access = await resolveGlobalActivityAccess(identity)
  const agentSquadIds = access.filter((entry) => entry.access.agentsRead).map((entry) => entry.squadId)
  const workStreamSquadIds = access.filter((entry) => entry.access.workstreamsRead).map((entry) => entry.squadId)

  const [workingAgents, activeStreams] = await Promise.all([
    agentSquadIds.length === 0
      ? []
      : db
          .select({ id: agents.id })
          .from(agents)
          .where(and(inArray(agents.squadId, agentSquadIds), eq(agents.status, 'active'))),
    workStreamSquadIds.length === 0
      ? []
      : db
          .select({
            id: workStreams.id,
            status: workStreams.status,
            assigneeAgentId: workStreams.assigneeAgentId,
            agentIds: workStreams.agentIds,
          })
          .from(workStreams)
          .where(
            and(inArray(workStreams.squadId, workStreamSquadIds), inArray(workStreams.status, ['queued', 'active']))
          ),
  ])

  const derived = await computeDerivedStates(activeStreams)
  const workingAgentIds = workingAgents.map((agent) => agent.id).sort()
  const needsYouCount = activeStreams.filter((stream) => {
    const presentation = derived.get(stream.id)
    return workStreamNeedsHumanAttention({
      status: stream.status,
      derivedState: presentation?.derivedState,
      openWaits: presentation?.openWaits,
    })
  }).length

  return {
    workingAgentIds,
    workingCount: workingAgentIds.length,
    needsYouCount,
    streamCount: activeStreams.length,
  }
}
