import { and, eq, inArray } from 'drizzle-orm'
import { workStreamFlowRuns } from '../../db'
import type { DbHandle } from '../work-streams/waits'
import { codeHostingRegistry } from '../integrations/code-hosting'
import type { WorkflowRun } from '@tau/shared'

/** A linked PR with event routing is an external wait, not abandoned delivery setup. */
export function awaitsCodeHostDelivery(state: WorkflowRun, metadata: unknown): boolean {
  return (
    state.status === 'completion-ready' &&
    ['pr-merge', 'pr-auto-merge'].includes(state.definition.completion.mode) &&
    state.definition.completion.followChanges === true &&
    !!codeHostingRegistry.resolve(metadata)?.reference.changeRequest
  )
}

export async function externalDeliveryStreamIds(store: DbHandle, streams: Array<{ id: string; metadata: unknown }>) {
  if (!streams.length) return new Set<string>()
  const runs = await store
    .select()
    .from(workStreamFlowRuns)
    .where(
      and(
        inArray(
          workStreamFlowRuns.workStreamId,
          streams.map((s) => s.id)
        ),
        eq(workStreamFlowRuns.activated, true)
      )
    )
  const metadata = new Map(streams.map((s) => [s.id, s.metadata]))
  return new Set(
    runs
      .filter((run) => awaitsCodeHostDelivery(run.state, metadata.get(run.workStreamId)))
      .map((run) => run.workStreamId)
  )
}
