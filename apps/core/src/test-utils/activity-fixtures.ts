import { eq, inArray } from 'drizzle-orm'
import { db, agents, executions, integrationEventPollingDispatches, workStreams, workStreamWaits } from '../db'
import { materializeSourceGroup } from '../services/squad-activity/materialize'
import type { ActivitySourceKey } from '../services/squad-activity/source-loaders'

/** Project only a route test's fixtures; never repair the entire shared DB. */
export async function materializeActivityFixtures(squadIds: string[], inboxIds: string[], dispatchKeys: string[] = []) {
  if (!squadIds.length) return
  const keys: ActivitySourceKey[] = inboxIds.map((groupId) => ({ family: 'inbox', groupId }))
  const executionRows = await db
    .select({ id: executions.id })
    .from(executions)
    .innerJoin(agents, eq(agents.id, executions.agentId))
    .where(inArray(agents.squadId, squadIds))
  for (const { id } of executionRows) keys.push({ family: 'execution', groupId: id }, { family: 'chat', groupId: id })
  const streams = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(inArray(workStreams.squadId, squadIds))
  keys.push(...streams.map(({ id }) => ({ family: 'workstream' as const, groupId: id })))
  if (streams.length) {
    const waits = await db
      .select({ id: workStreamWaits.id })
      .from(workStreamWaits)
      .where(
        inArray(
          workStreamWaits.workStreamId,
          streams.map(({ id }) => id)
        )
      )
    keys.push(...waits.map(({ id }) => ({ family: 'wait' as const, groupId: id })))
  }
  if (dispatchKeys.length) {
    const dispatches = await db
      .select()
      .from(integrationEventPollingDispatches)
      .where(inArray(integrationEventPollingDispatches.eventKey, dispatchKeys))
    for (const dispatch of dispatches)
      for (const squadId of dispatch.activitySquadIds ?? []) {
        if (squadIds.includes(squadId))
          keys.push({ family: 'github-pr', groupId: `poll:${dispatch.activityId}:${squadId}` })
      }
  }
  // Serial transactions leave capacity for request handlers/background work.
  for (const key of keys) await materializeSourceGroup(key, { publish: false })
}
