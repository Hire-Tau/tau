import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'

/**
 * Invalidate the React Query cache for a sandbox whose status just changed,
 * given its sandbox id. The id prefix tells us which status query to refetch:
 *   agent_<id>            → that agent's sandbox status
 *   squad_<id>            → that squad's sandbox status
 *   system_manager_<uid>  → every active agent sandbox-status query (the box is
 *                           shared by many agents, so we can't target one)
 * React Query only refetches mounted observers, so the predicate is cheap.
 */
export function invalidateSandboxStatus(queryClient: Pick<QueryClient, 'invalidateQueries'>, sandboxId: string): void {
  if (sandboxId.startsWith('agent_')) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.agents.sandboxStatus(sandboxId.slice('agent_'.length)),
    })
    return
  }
  if (sandboxId.startsWith('system_manager_')) {
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'agents' && query.queryKey[2] === 'sandboxStatus',
    })
    return
  }
  if (sandboxId.startsWith('squad_')) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.sandbox.status(sandboxId.slice('squad_'.length)),
    })
  }
}
