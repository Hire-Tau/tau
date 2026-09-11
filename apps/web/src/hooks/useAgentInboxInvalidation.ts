import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWebSocket } from './useWebSocket'
import { queryKeys } from '../queryKeys'

interface Options {
  includeMessages?: boolean
}

/**
 * Subscribes to recipient-scoped inbox websocket topics for active agent inbox UI.
 *
 * The bridge also emits on the collection `inbox` topic for global human/voice listeners,
 * but agent views use `inbox:<agentId>` so inbox events only invalidate the affected
 * agent's message list while that inbox is open.
 */
export function useAgentInboxInvalidation(agentIds: readonly string[], options: Options = {}) {
  const queryClient = useQueryClient()
  const { subscribe } = useWebSocket()
  const includeMessages = options.includeMessages ?? false

  useEffect(() => {
    const unsubscribes = agentIds.map((agentId) =>
      subscribe(`inbox:${agentId}`, () => {
        if (includeMessages) {
          queryClient.invalidateQueries({ queryKey: queryKeys.inbox.messagesPrefix(agentId) })
        }
      })
    )

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [agentIds, includeMessages, queryClient, subscribe])
}
