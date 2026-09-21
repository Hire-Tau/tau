import type {
  AgentStatus,
  ExecutionStatus,
  SandboxRuntimeState,
  SandboxToolchainStatus,
  WorkStreamDerivedState,
  WorkStreamStatus,
  WorkStreamWaitType,
} from './types'

/** Platform-neutral meanings used by web, mobile, and native adapters. */
export type StatusRole =
  | 'progress'
  | 'queue'
  | 'review'
  | 'humanWait'
  | 'externalWait'
  | 'attention'
  | 'danger'
  | 'success'
  | 'neutral'

export type AgentPresentationState = AgentStatus | 'offline'
export type DeliveryPresentationKind = 'approval' | 'review' | 'merge' | 'external' | 'setup' | 'failure'

/** Server-owned delivery facts, never inferred from client metadata. Unknown kinds are ignored. */
export interface WorkStreamDeliveryPresentation {
  kind: DeliveryPresentationKind
  /** The one operational approval wait represented by this gate; other waits retain precedence. */
  approvalWaitId?: string
}

export type WorkStreamPresentationState =
  | WorkStreamStatus
  | WorkStreamDerivedState
  | `delivery_${DeliveryPresentationKind}`
export type SubagentPresentationState = 'queued' | 'running' | 'idle' | 'stopped' | 'done' | 'failed'
export type SandboxPresentationState = SandboxRuntimeState | 'installing_packages' | 'running_setup' | 'degraded'

export const AGENT_STATUS_ROLE = {
  active: 'progress',
  idle: 'neutral',
  'waiting-input': 'humanWait',
  compacting: 'attention',
  resetting: 'attention',
  dormant: 'neutral',
  terminated: 'neutral',
  offline: 'neutral',
} as const satisfies Record<AgentPresentationState, StatusRole>

export const WORK_STREAM_STATUS_ROLE = {
  delivery_approval: 'review',
  delivery_review: 'review',
  delivery_merge: 'review',
  delivery_external: 'externalWait',
  delivery_setup: 'danger',
  delivery_failure: 'danger',
  paused: 'neutral',
  queued: 'queue',
  active: 'progress',
  in_progress: 'progress',
  in_review: 'review',
  waiting_on_answer: 'humanWait',
  waiting_on_dependency: 'externalWait',
  blocked: 'danger',
  idle: 'danger',
  execution_failed: 'danger',
  done: 'success',
  canceled: 'neutral',
} as const satisfies Record<WorkStreamPresentationState, StatusRole>

export const EXECUTION_STATUS_ROLE = {
  queued: 'queue',
  'waiting-maintenance': 'externalWait',
  'waiting-sandbox': 'externalWait',
  running: 'progress',
  stopping: 'attention',
  stopped: 'neutral',
  completed: 'success',
  failed: 'danger',
} as const satisfies Record<ExecutionStatus, StatusRole>

export const SUBAGENT_STATUS_ROLE = {
  queued: 'queue',
  running: 'progress',
  idle: 'neutral',
  stopped: 'neutral',
  done: 'success',
  failed: 'danger',
} as const satisfies Record<SubagentPresentationState, StatusRole>

export const SANDBOX_STATUS_ROLE = {
  not_found: 'neutral',
  pending: 'attention',
  starting: 'attention',
  running: 'success',
  succeeded: 'neutral',
  failed: 'danger',
  terminating: 'attention',
  unknown: 'neutral',
  installing_packages: 'progress',
  running_setup: 'progress',
  degraded: 'attention',
} as const satisfies Record<SandboxPresentationState, StatusRole>

export const WORK_STREAM_WAIT_DISPLAY_PRECEDENCE = [
  'review',
  'question',
  'dependency',
  'manual',
] as const satisfies readonly WorkStreamWaitType[]

export const WORK_STREAM_WAIT_STATE = {
  review: 'in_review',
  question: 'waiting_on_answer',
  dependency: 'waiting_on_dependency',
  manual: 'blocked',
} as const satisfies Record<WorkStreamWaitType, WorkStreamDerivedState>

export interface WorkStreamPresentationFacts {
  delivery?: WorkStreamDeliveryPresentation
  pause?: unknown
  status: WorkStreamStatus
  derivedState?: WorkStreamDerivedState
  openWaits?: ReadonlyArray<{ type: WorkStreamWaitType; id?: string }>
}

/**
 * Select one display state from server facts. An explicit wait list is
 * authoritative; omitted waits retain compatibility with older payloads.
 */
export function selectWorkStreamPresentationState(
  workStream: WorkStreamPresentationFacts
): WorkStreamPresentationState {
  if (workStream.status === 'done' || workStream.status === 'canceled') return workStream.status

  if (workStream.pause || workStream.derivedState === 'paused') return 'paused'

  const deliveryState =
    workStream.delivery &&
    ['approval', 'review', 'merge', 'external', 'setup', 'failure'].includes(workStream.delivery.kind)
      ? (`delivery_${workStream.delivery.kind}` as WorkStreamPresentationState)
      : undefined
  if (workStream.openWaits !== undefined) {
    const waitType = WORK_STREAM_WAIT_DISPLAY_PRECEDENCE.find((type) =>
      workStream.openWaits!.some(
        (wait) =>
          wait.type === type &&
          !(deliveryState === 'delivery_approval' && wait.id && wait.id === workStream.delivery?.approvalWaitId)
      )
    )
    if (waitType) return WORK_STREAM_WAIT_STATE[waitType]
    if (workStream.derivedState === 'execution_failed') return 'execution_failed'
    if (deliveryState) return deliveryState
    if (workStream.status === 'queued') return 'queued'
    // Non-wait-derived states survive an explicit empty wait list: an empty
    // list cannot speak against a live execution or a failed execution, but a
    // STALE wait-derived state (in_review/…) must still collapse to idle.
    if (workStream.derivedState === 'in_progress') return 'in_progress'
    return 'idle'
  }

  if (workStream.derivedState === 'execution_failed') return 'execution_failed'
  return deliveryState ?? workStream.derivedState ?? workStream.status
}

/** Whether a stream contributes to a user-attention aggregate. */
export function workStreamNeedsHumanAttention(workStream: WorkStreamPresentationFacts): boolean {
  const state = selectWorkStreamPresentationState(workStream)
  if (state === 'delivery_approval' || state === 'delivery_review' || state === 'delivery_merge') return true
  if (state === 'in_review' || state === 'waiting_on_answer') return true
  if (state !== 'blocked') return false

  // Explicit wait facts distinguish a manual wait from dependency blocking.
  // Older payloads omitted waits, so their historical `blocked` fallback is
  // retained until all producers provide the authoritative list.
  return workStream.openWaits === undefined || workStream.openWaits.some((wait) => wait.type === 'manual')
}

export interface SandboxPresentationFacts {
  status: SandboxRuntimeState
  devboxReady?: boolean
  readiness?: 'pending' | 'reconciling' | 'ready' | 'ready_degraded'
  toolchain?: { status: SandboxToolchainStatus }
}

/** Project physical and setup facts into a named state before applying UI treatment. */
export function selectSandboxPresentationState(facts: SandboxPresentationFacts): SandboxPresentationState {
  if (facts.status !== 'running') return facts.status
  if (facts.readiness === 'ready_degraded') return 'degraded'
  if (facts.toolchain?.status === 'failed') return 'failed'
  if (facts.toolchain?.status === 'running_setup') return 'running_setup'
  if (facts.toolchain?.status === 'installing') return 'installing_packages'
  if (facts.toolchain?.status === 'pending') return 'degraded'
  if (facts.devboxReady === false) return 'installing_packages'
  return 'running'
}
