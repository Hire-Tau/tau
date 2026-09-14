import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import type { EntityReference } from '../lib/entityReference'
import { Modal } from './Modal'
import { WorkStreamViewModal } from './WorkStreamViewModal'
import { ChatSkeleton } from './loading/Skeleton'

const Conversation = lazy(() =>
  import('./AgentConversationBody').then((module) => ({ default: module.AgentConversation }))
)

export function EntityReferenceModal({ reference, onClose }: { reference: EntityReference; onClose: () => void }) {
  if (reference.kind === 'ws') return <WorkStreamReference id={reference.id} onClose={onClose} />
  return (
    <Modal isOpen title="Agent chat" size="viewport" noChildPadding onClose={onClose}>
      <Suspense fallback={<ChatSkeleton label="Loading conversation" />}>
        <Conversation agentId={reference.id} embedded enableFullscreen={false} />
      </Suspense>
    </Modal>
  )
}

function WorkStreamReference({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isError } = useQuery(queries.squads.workStreamDetail(id))
  if (data) return <WorkStreamViewModal workStreamId={id} squadId={data.squadId} onClose={onClose} />
  return (
    <Modal isOpen title="Work stream" onClose={onClose}>
      <p role="status">
        {isError
          ? 'This work stream could not be opened. It may be unavailable or you may not have access.'
          : 'Loading work stream…'}
      </p>
    </Modal>
  )
}
