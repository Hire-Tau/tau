import { codeHostingRegistry } from '../code-hosting'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '../../../db'
import { workStreams, workStreamFlowRuns, squads } from '../../../db/schema'
import type { WorkStreamCandidate } from './watch-policy'

export async function listGitHubPrWorkStreamCandidates(): Promise<WorkStreamCandidate[]> {
  return db
    .select({
      squadId: workStreams.squadId,
      status: workStreams.status,
      metadata: workStreams.metadata,
      flow: workStreamFlowRuns.state,
    })
    .from(workStreams)
    .leftJoin(workStreamFlowRuns, eq(workStreamFlowRuns.workStreamId, workStreams.id))
    .where(and(ne(workStreams.status, 'done'), ne(workStreams.status, 'canceled')))
    .then((rows) =>
      rows.map(({ flow, ...stream }) => ({
        ...stream,
        subscriptions: flow ? codeHostingRegistry.subscriptions(flow.definition, stream.metadata) : undefined,
      }))
    )
}

export async function listGitHubTriggerSquads() {
  return db.select({ id: squads.id, metadata: squads.metadata }).from(squads).where(eq(squads.status, 'active'))
}
