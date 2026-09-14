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
  return <AgentReference id={reference.id} onClose={onClose} />
}

function AgentReference({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isError } = useQuery(queries.agents.detail(id))
  return (
    <Modal isOpen title="Agent chat" size="viewport" noChildPadding onClose={onClose}>
      <Suspense fallback={<ChatSkeleton label="Loading conversation" />}>
        {data ? (
          <Conversation agentId={data.id} embedded enableFullscreen={false} />
        ) : (
          <p role="status">
            {isError
              ? 'This agent could not be opened. The ID may be ambiguous, unavailable, or inaccessible. Try its full UUID.'
              : 'Loading conversation…'}
          </p>
        )}
      </Suspense>
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
