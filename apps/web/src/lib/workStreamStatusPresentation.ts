import {
  selectWorkStreamPresentationState,
  WORK_STREAM_STATUS_ROLE,
  type WorkStreamPresentationFacts,
  type WorkStreamPresentationState,
} from '@tau/shared'
import type { BadgeColor } from '../components/Badge'
import { webStatus } from './statusPresentation'

// Merged label/color maps covering BOTH stored statuses (queued/active/done/canceled) and derived
// display states (in_progress/in_review/waiting_on_answer/waiting_on_dependency/blocked/idle). The
// key spaces overlap on queued/done/canceled, which share the same label either way.
export const WS_STATUS_LABELS: Record<WorkStreamPresentationState, string> = {
  delivery_approval: 'Approve Delivery',
  delivery_review: 'Review Pull Request',
  delivery_merge: 'Merge Pull Request',
  delivery_external: 'Awaiting Code Host',
  delivery_setup: 'Delivery Setup Required',
  delivery_failure: 'Delivery Changes Required',
  // Stored statuses
  queued: 'Queued',
  active: 'Active',
  done: 'Done',
  canceled: 'Canceled',
  // Derived display states
  in_progress: 'In Progress',
  in_review: 'In Review',
  waiting_on_answer: 'Waiting on Answer',
  waiting_on_dependency: 'Waiting on Dependency',
  blocked: 'Blocked',
  idle: 'Idle',
  execution_failed: 'Execution Failed',
  paused: 'Paused',
}

export const WS_STATUS_BADGE_COLORS: Record<WorkStreamPresentationState, BadgeColor> = {
  delivery_approval: webStatus(WORK_STREAM_STATUS_ROLE.delivery_approval).badgeColor,
  delivery_review: webStatus(WORK_STREAM_STATUS_ROLE.delivery_review).badgeColor,
  delivery_merge: webStatus(WORK_STREAM_STATUS_ROLE.delivery_merge).badgeColor,
  delivery_external: webStatus(WORK_STREAM_STATUS_ROLE.delivery_external).badgeColor,
  delivery_failure: webStatus(WORK_STREAM_STATUS_ROLE.delivery_failure).badgeColor,
  delivery_setup: webStatus(WORK_STREAM_STATUS_ROLE.delivery_setup).badgeColor,

  queued: webStatus(WORK_STREAM_STATUS_ROLE.queued).badgeColor,
  active: webStatus(WORK_STREAM_STATUS_ROLE.active).badgeColor,
  done: webStatus(WORK_STREAM_STATUS_ROLE.done).badgeColor,
  canceled: webStatus(WORK_STREAM_STATUS_ROLE.canceled).badgeColor,
  in_progress: webStatus(WORK_STREAM_STATUS_ROLE.in_progress).badgeColor,
  in_review: webStatus(WORK_STREAM_STATUS_ROLE.in_review).badgeColor,
  waiting_on_answer: webStatus(WORK_STREAM_STATUS_ROLE.waiting_on_answer).badgeColor,
  waiting_on_dependency: webStatus(WORK_STREAM_STATUS_ROLE.waiting_on_dependency).badgeColor,
  blocked: webStatus(WORK_STREAM_STATUS_ROLE.blocked).badgeColor,
  idle: webStatus(WORK_STREAM_STATUS_ROLE.idle).badgeColor,
  execution_failed: webStatus(WORK_STREAM_STATUS_ROLE.execution_failed).badgeColor,
  paused: webStatus(WORK_STREAM_STATUS_ROLE.paused).badgeColor,
}

export const getWsDisplayState = selectWorkStreamPresentationState

/** Queued work with a retained wait or pause has released its admission slot. */
export function isWorkStreamParked(workStream: WorkStreamPresentationFacts): boolean {
  if (workStream.status !== 'queued') return false
  return ['in_review', 'waiting_on_answer', 'waiting_on_dependency', 'blocked', 'paused'].includes(
    // Admission state follows retained waits/pause, independently of delivery's primary label.
    getWsDisplayState({ ...workStream, delivery: undefined })
  )
}
