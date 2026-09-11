import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { WorkStreamDetailModal } from './WorkStreamDetailModal'

/**
 * Opens a WorkStreamDetailModal in-place from a workStreamId + squadId. Fetches the work stream,
 * the squad's agents, and (when the caller doesn't already have it) the squad name. Used by the
 * Action Center and by inbox-delivery chat messages.
 */
export function WorkStreamViewModal({
  workStreamId,
  squadId,
  squadName,
  focusWaitId,
  actionCanRespond,
  onClose,
}: {
  workStreamId: string
  squadId: string
  squadName?: string
  focusWaitId?: string
  actionCanRespond?: boolean
  onClose: () => void
}) {
  const { data: workStream } = useQuery(queries.squads.workStreamDetail(workStreamId))
  const { data: squadAgents } = useQuery(queries.squads.agents(squadId))
  // Resolve the squad name only when the caller didn't pass one (e.g. opened from an inbox message).
  const { data: squad } = useQuery({ ...queries.squads.basic(squadId), enabled: !squadName })
  const resolvedName = squadName ?? squad?.name ?? ''

  const squadMap = useMemo(() => new Map([[squadId, { id: squadId, name: resolvedName }]]), [squadId, resolvedName])
  const agentMap = useMemo(() => new Map((squadAgents ?? []).map((a) => [a.id, a])), [squadAgents])

  if (!workStream) return null

  return (
    // squadMap holds a {id,name} stub rather than a full Squad — sufficient for the modal's display.
    <WorkStreamDetailModal
      workStream={workStream}
      squadMap={squadMap as never}
      agentMap={agentMap}
      focusWaitId={focusWaitId}
      actionCanRespond={actionCanRespond}
      onClose={onClose}
    />
  )
}
