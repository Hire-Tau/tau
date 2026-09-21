import { assistantSummaryUpdateIds } from '../lib/assistantSummarySources'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RenderItem } from '@tau/client-core'
import { assistantQueries } from '../queryOptions'
import { assistantApi } from '../api/assistant'
import { MarkdownContent } from './MarkdownContent'

/** Source IDs come from every grouped row. Retrieval does not depend on the latest update page. */
export function AssistantSummarySources({
  ownerId,
  conversationId,
  item,
  visible,
}: {
  ownerId: string
  conversationId: string
  item: Extract<RenderItem, { kind: 'persisted' }>
  visible: boolean
}) {
  const ids = assistantSummaryUpdateIds(item)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState(false)
  const query = useQuery({
    ...assistantQueries.updates(ownerId, conversationId, ids),
    enabled: ids.length > 0 && expanded,
  })
  if (!ids.length) return null
  return (
    <details className="min-w-0 px-3 pb-3 text-sm" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer text-muted">Task updates · {ids.length}</summary>
      {query.isError ? (
        <button
          className="tau-button"
          onClick={() => {
            void query.refetch()
          }}
        >
          Retry loading updates
        </button>
      ) : query.isPending ? (
        <p role="status">Loading updates…</p>
      ) : (
        query.data.map((update) => (
          <div key={update.messageId} className="my-2 rounded-lg bg-surface-secondary p-3 [overflow-wrap:anywhere]">
            <MarkdownContent>{update.content}</MarkdownContent>
            {visible && !update.seenAt && (
              <button
                className="tau-button mt-2"
                onClick={async () => {
                  try {
                    await assistantApi.seen(conversationId, [update.messageId])
                    await query.refetch()
                    setError(false)
                  } catch {
                    setError(true)
                  }
                }}
              >
                Mark read
              </button>
            )}
          </div>
        ))
      )}
      {error && <p role="alert">Could not mark the update read. Try again.</p>}
    </details>
  )
}
