import clsx from 'clsx'
import { AGENT_STATUS_ROLE, type AgentStatus } from '@tau/shared'
import { webStatus } from '../lib/statusPresentation'

const STATUS_LABELS: Record<AgentStatus, string> = {
  active: 'Working',
  idle: 'Idle',
  'waiting-input': 'Waiting for input',
  compacting: 'Compacting',
  resetting: 'Resetting',
  dormant: 'Dormant',
  terminated: 'Terminated',
}

export function AgentActivityDot({ status, className }: { status: AgentStatus; className?: string }) {
  const description = `Agent activity: ${STATUS_LABELS[status]}`
  const treatment = webStatus(AGENT_STATUS_ROLE[status])

  return (
    <span
      role="img"
      aria-label={description}
      title={description}
      className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', treatment.markerClass, className)}
    />
  )
}
