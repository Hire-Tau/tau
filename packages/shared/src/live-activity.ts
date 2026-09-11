import { selectWorkStreamPresentationState } from './status-presentation'
import type { WorkStream, WorkStreamDerivedState, WorkStreamStatus, WorkStreamWaitType } from './types'

/** Explicit reduced vocabulary used by WidgetKit and ActivityKit. */
export type WorkBucket = 'needsYou' | 'running' | 'blocked' | 'queued'

export interface WorkBucketFacts {
  status: WorkStreamStatus
  derivedState?: WorkStreamDerivedState
  openWaits?: ReadonlyArray<{ type: WorkStreamWaitType }>
}

/** Project precise work semantics into the intentionally reduced native buckets. */
export function workBucket(stream: WorkBucketFacts): WorkBucket {
  const state = selectWorkStreamPresentationState(stream)
  if (state === 'in_review' || state === 'waiting_on_answer') return 'needsYou'
  if (state === 'blocked' && stream.openWaits?.some((wait) => wait.type === 'manual')) return 'needsYou'
  if (state === 'blocked' || state === 'idle' || state === 'waiting_on_dependency') return 'blocked'
  if (state === 'active' || state === 'in_progress') return 'running'
  return 'queued'
}

/** One row in the activity's short list. Mirrors `StreamLite` in TauWorkAttributes.swift. */
export interface StreamLite {
  id: string
  title: string
  bucket: WorkBucket
  squadId: string
  agentId?: string
}

export interface LiveActivityState {
  activeCount: number
  needsYouCount: number
  top: StreamLite[]
}

export const LIVE_ACTIVITY_TOP_LIMIT = 3
export const WIDGET_TOP_LIMIT = 8

/** Safe server-owned row consumed by the native widget. */
export interface WidgetWorkStreamSummary {
  id: string
  squadId: string
  title: string
  status: WorkStreamStatus
  derivedState?: WorkStreamDerivedState
  assigneeAgentId?: string
  /** An explicit empty array is authoritative and must survive serialization. */
  openWaitTypes: WorkStreamWaitType[]
  updatedAt: string
}

export interface WorkInterestSnapshot {
  asOf: string
  totalCount: number
  bucketCounts: Record<WorkBucket, number>
  top: WidgetWorkStreamSummary[]
  liveActivity: LiveActivityState
}

type SnapshotSource = Pick<
  WorkStream,
  'id' | 'squadId' | 'title' | 'status' | 'derivedState' | 'assigneeAgentId' | 'openWaits' | 'updatedAt'
>

function updatedAtMs(stream: Pick<SnapshotSource, 'updatedAt'>): number {
  return new Date(stream.updatedAt).getTime()
}

/** Canonical attention-first ordering shared by widget and Live Activity projections. */
export function compareWorkInterest(left: SnapshotSource, right: SnapshotSource): number {
  const leftNeedsYou = workBucket(left) === 'needsYou'
  const rightNeedsYou = workBucket(right) === 'needsYou'
  if (leftNeedsYou !== rightNeedsYou) return leftNeedsYou ? -1 : 1
  const recency = updatedAtMs(right) - updatedAtMs(left)
  return recency || left.id.localeCompare(right.id)
}

function toStreamLite(stream: SnapshotSource): StreamLite {
  const row: StreamLite = {
    id: stream.id,
    title: stream.title,
    bucket: workBucket(stream),
    squadId: stream.squadId,
  }
  if (stream.assigneeAgentId) row.agentId = stream.assigneeAgentId
  return row
}

function toWidgetSummary(stream: SnapshotSource): WidgetWorkStreamSummary {
  const row: WidgetWorkStreamSummary = {
    id: stream.id,
    squadId: stream.squadId,
    title: stream.title,
    status: stream.status,
    openWaitTypes: stream.openWaits?.map(({ type }) => type) ?? [],
    updatedAt: new Date(stream.updatedAt).toISOString(),
  }
  if (stream.derivedState) row.derivedState = stream.derivedState
  if (stream.assigneeAgentId) row.assigneeAgentId = stream.assigneeAgentId
  return row
}

export function buildWorkInterestSnapshot(streams: SnapshotSource[], now: Date = new Date()): WorkInterestSnapshot {
  const ordered = [...streams].sort(compareWorkInterest)
  const bucketCounts: Record<WorkBucket, number> = { needsYou: 0, running: 0, blocked: 0, queued: 0 }
  for (const stream of ordered) bucketCounts[workBucket(stream)] += 1

  return {
    asOf: now.toISOString(),
    totalCount: ordered.length,
    bucketCounts,
    top: ordered.slice(0, WIDGET_TOP_LIMIT).map(toWidgetSummary),
    liveActivity: {
      activeCount: bucketCounts.running,
      needsYouCount: bucketCounts.needsYou,
      top: ordered.slice(0, LIVE_ACTIVITY_TOP_LIMIT).map(toStreamLite),
    },
  }
}

export function buildLiveActivityState(streams: SnapshotSource[]): LiveActivityState {
  return buildWorkInterestSnapshot(streams).liveActivity
}

export function shouldShowLiveActivity(state: LiveActivityState): boolean {
  return state.activeCount > 0 || state.needsYouCount > 0
}

export function serializeLiveActivityState(streams: SnapshotSource[]): string {
  return JSON.stringify(buildLiveActivityState(streams))
}
