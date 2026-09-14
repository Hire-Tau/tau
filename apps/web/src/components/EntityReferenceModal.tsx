import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStableRef } from '../hooks/useStableRef'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import type { EntityReference } from '../lib/entityReference'
import { Modal } from './Modal'
import { WorkStreamViewModal } from './WorkStreamViewModal'
export function EntityReferenceModal({ reference, onClose }: { reference: EntityReference; onClose: () => void }) {
  if (reference.kind === 'ws') return <WorkStreamReference id={reference.id} onClose={onClose} />
  return <AgentReference id={reference.id} onClose={onClose} />
}

function AgentReference({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isError } = useQuery(queries.agents.detail(id))
  const navigate = useNavigate()
  const onCloseRef = useStableRef(onClose)
  useEffect(() => {
    if (!data) return
    const path = data.squadId
      ? `/squads/${encodeURIComponent(data.squadId)}/agents?agent=${encodeURIComponent(data.id)}`
      : `/chat/${encodeURIComponent(data.id)}`
    onCloseRef.current()
    navigate(path)
  }, [data, navigate, onCloseRef])
  return (
    <Modal isOpen title="Agent chat" onClose={onClose}>
      <p role="status">
        {isError
          ? 'This agent could not be opened. The ID may be ambiguous, unavailable, or inaccessible. Try its full UUID.'
          : 'Opening conversation…'}
      </p>
    </Modal>
  )
}

function WorkStreamReference({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isError } = useQuery(queries.squads.workStreamDetail(id))
  if (data) return <WorkStreamViewModal workStreamId={data.id} squadId={data.squadId} onClose={onClose} />
  return (
    <Modal isOpen title="Work stream" onClose={onClose}>
      <p role="status">
        {isError
          ? 'This work stream could not be opened. The ID may be ambiguous, unavailable, or inaccessible. Try its full UUID.'
          : 'Loading work stream…'}
      </p>
    </Modal>
  )
}
