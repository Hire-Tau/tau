import { usePermissions } from '../hooks/usePermissions'
import { useQuery } from '../reactQueryHooks'
import { queries } from '../queryOptions'

/** Additional context, not an exclusive explanation of the agent's activity. */
export function AgentSlotWaitStatus({ agentId, squadId }: { agentId: string; squadId: string }) {
  const permissions = usePermissions(squadId)
  const enabled =
    Boolean(agentId && squadId) &&
    !permissions.isLoading &&
    !permissions.isError &&
    (permissions.can('slots:use') || permissions.can('slots:write'))
  const { data, isError } = useQuery({ ...queries.agents.slotWaits(squadId, agentId), enabled })

  // A failed permission/read check must never keep claiming cached waits are
  // current. Initial loading and an empty projection add no chat chrome.
  if (!enabled) return null
  if (isError)
    return (
      <div className="text-xs text-secondary py-1" role="status">
        Slot wait status unavailable
      </div>
    )
  if (!data?.length) return null
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 min-w-0 py-1 text-xs text-secondary"
    >
      <span className="shrink-0">Queued for slots:</span>
      <ul className="flex flex-wrap gap-x-2 gap-y-0.5 min-w-0" aria-label="Queued slot pools">
        {data.map((wait) => (
          <li key={wait.waiterId} className="min-w-0 break-all font-medium text-primary">
            {wait.poolKey}
          </li>
        ))}
      </ul>
    </div>
  )
}
