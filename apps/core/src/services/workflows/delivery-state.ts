import { and, eq, inArray } from 'drizzle-orm'
import { workStreamFlowRuns, workStreams, squads, integrationOutputEvents, integrationOutputDeliveries } from '../../db'
import type { DbHandle } from '../work-streams/waits'
import { codeHostingRegistry } from '../integrations/code-hosting'
import {
  deliveryPullRequests,
  type WorkflowRun,
  type IntegrationOutputFact,
  type WorkStreamDeliveryPresentation,
} from '@tau/shared'

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

export type DeliveryEvent = IntegrationOutputFact & { integration: string; connectionId?: string }

/**
 * Read only event evidence routed to this stream by the integration runtime. A
 * workflow success is NOT aggregate CI success. Only a current PR snapshot can
 * assert merge readiness; unknown evidence remains an external wait.
 */
function classifyPrimaryDeliveryPresentation(
  state: WorkflowRun,
  metadata: unknown,
  events: DeliveryEvent[],
  policies?: { allowAutoMerge?: boolean }
): WorkStreamDeliveryPresentation | { kind: 'merged' } | undefined {
  if (state.status !== 'completion-ready') return undefined
  const mode = state.definition.completion.mode
  if (mode === 'review-approval') return { kind: 'approval' }
  if (!['pr-merge', 'pr-auto-merge', 'direct-merge'].includes(mode)) return undefined
  const git = (metadata as { git?: { commit?: string; branch?: string; baseBranch?: string } } | null)?.git
  if (mode === 'direct-merge') {
    return {
      kind:
        codeHostingRegistry.resolve(metadata) &&
        typeof git?.commit === 'string' &&
        /^[a-f0-9]{40}$/.test(git.commit) &&
        typeof git?.baseBranch === 'string' &&
        git.baseBranch.trim()
          ? 'external'
          : 'setup',
    }
  }
  if (!awaitsCodeHostDelivery(state, metadata)) return { kind: 'setup' }
  const reference = codeHostingRegistry.resolve(metadata)!.reference
  const matching = events
    .filter((event) => {
      const pr = event.data.pullRequest as { number?: number } | undefined
      return (
        event.integration === reference.integration &&
        (!reference.connectionId || event.connectionId === reference.connectionId) &&
        event.data.repository === reference.repository.toLowerCase() &&
        pr?.number === reference.changeRequest!.number &&
        Number.isFinite(Date.parse(event.occurredAt))
      )
    })
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
  const head = (event: IntegrationOutputFact) => (event.data.pullRequest as { headSha?: string } | undefined)?.headSha
  // Late CI on an old commit cannot change the PR's head. Reviews may also be
  // delivered out of order, hence the provider occurrence timestamp ordering.
  const snapshot = matching.find((event) => event.output !== 'pull_request.ci_completed' && head(event))
  const currentHead = snapshot && head(snapshot)
  if (!currentHead || !/^[a-f0-9]{40}$/.test(currentHead)) {
    return { kind: matching[0]?.data.state === 'failure' ? 'failure' : 'external' }
  }
  if (
    (git?.branch && snapshot?.data.headBranch && git.branch !== snapshot.data.headBranch) ||
    (git?.baseBranch && snapshot?.data.baseBranch && git.baseBranch !== snapshot.data.baseBranch)
  )
    return { kind: 'setup' }
  if (snapshot?.data.draft === true) return { kind: 'external' }
  const current = matching.filter((event) => head(event) === currentHead)
  const latest = current[0]!
  const lifecycle = current.find((event) =>
    ['pull_request.updated', 'pull_request.merged', 'pull_request.closed'].includes(event.output)
  )
  if (lifecycle?.output === 'pull_request.merged') return { kind: 'merged' }
  // Negative facts remain visible until a newer aggregate snapshot clears them.
  const aggregate = current.find(
    (event) => event.output === 'pull_request.updated' && event.data.mergeState === 'clean'
  )
  const unresolved = current.filter(
    (event) => !aggregate || Date.parse(event.occurredAt) >= Date.parse(aggregate.occurredAt)
  )
  if (
    unresolved.some(
      (event) =>
        event.data.mergeConflict === true ||
        event.output === 'pull_request.closed' ||
        (event.data.state === 'changes_requested' &&
          (!event.data.reviewedHeadSha || event.data.reviewedHeadSha === currentHead)) ||
        (event.output === 'pull_request.ci_completed' &&
          ['failure', 'cancelled', 'timed_out', 'action_required'].includes(String(event.data.state)))
    )
  ) {
    return { kind: 'failure' }
  }
  if (
    snapshot?.data.pendingHumanReview === true ||
    (snapshot?.data.pendingHumanReview === undefined &&
      snapshot?.output === 'pull_request.review_requested' &&
      ((snapshot.data.requestedReviewerType === 'User' &&
        typeof snapshot.data.requestedReviewer === 'string' &&
        snapshot.data.requestedReviewer.length > 0) ||
        (typeof snapshot.data.requestedTeam === 'string' && snapshot.data.requestedTeam.length > 0)))
  )
    return { kind: 'review' }
  if (latest === aggregate && (mode === 'pr-merge' || policies?.allowAutoMerge === false)) return { kind: 'merge' }
  return { kind: 'external' }
}

/** All designated PRs participate; an unknown extra PR cannot advertise a ready merge. */
export function classifyDeliveryPresentation(
  state: WorkflowRun,
  metadata: unknown,
  events: DeliveryEvent[],
  policies?: { allowAutoMerge?: boolean }
): WorkStreamDeliveryPresentation | undefined {
  const primary = classifyPrimaryDeliveryPresentation(state, metadata, events, policies)
  if (!primary || !['pr-merge', 'pr-auto-merge'].includes(state.definition.completion.mode) || primary.kind === 'setup')
    return primary?.kind === 'merged' ? { kind: 'external' } : primary
  const gates = [
    primary,
    ...deliveryPullRequests(metadata)
      .filter((resource) => resource.source !== 'delivery')
      .map(
        (resource) =>
          classifyPrimaryDeliveryPresentation(
            state,
            {
              codeHost: {
                integration: resource.integration,
                repository: resource.repository,
                changeRequest: { number: resource.number },
                ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
              },
            },
            events,
            policies
          )!
      ),
  ]
  for (const kind of ['setup', 'failure', 'review', 'external', 'merge'] as const) {
    if (gates.some((gate) => gate.kind === kind)) return { kind }
  }
  return primary.kind === 'merged' ? { kind: 'external' } : primary
}

/** Batched local reads only: serialization never performs provider requests. */
export async function loadDeliveryPresentations(store: DbHandle, ids: string[]) {
  const result = new Map<string, WorkStreamDeliveryPresentation>()
  if (!ids.length) return result
  const runs = await store
    .select({
      id: workStreamFlowRuns.workStreamId,
      state: workStreamFlowRuns.state,
      metadata: workStreams.metadata,
      squadMetadata: squads.metadata,
    })
    .from(workStreamFlowRuns)
    .innerJoin(workStreams, eq(workStreams.id, workStreamFlowRuns.workStreamId))
    .innerJoin(squads, eq(squads.id, workStreams.squadId))
    .where(and(inArray(workStreamFlowRuns.workStreamId, ids), eq(workStreamFlowRuns.activated, true)))
  const candidates = runs.filter((run) => run.state.status === 'completion-ready')
  if (!candidates.length) return result
  const rows = await store
    .select({
      id: integrationOutputDeliveries.workStreamId,
      fact: integrationOutputEvents.fact,
      integration: integrationOutputEvents.integration,
      authority: integrationOutputEvents.authority,
    })
    .from(integrationOutputDeliveries)
    .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, integrationOutputDeliveries.eventId))
    .where(
      inArray(
        integrationOutputDeliveries.workStreamId,
        candidates.map((run) => run.id)
      )
    )
  const byStream = new Map<string, DeliveryEvent[]>()
  for (const row of rows) {
    const facts = byStream.get(row.id) ?? []
    facts.push({
      ...row.fact,
      integration: row.integration,
      ...(row.authority.kind === 'connection' ? { connectionId: row.authority.connectionId } : {}),
    })
    byStream.set(row.id, facts)
  }
  for (const run of candidates) {
    const presentation = classifyDeliveryPresentation(run.state, run.metadata, byStream.get(run.id) ?? [], {
      allowAutoMerge:
        (run.squadMetadata as { policies?: { allowAutoMerge?: boolean } } | null)?.policies?.allowAutoMerge === true,
    })
    if (presentation) result.set(run.id, presentation)
  }
  return result
}
