import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { subscribeSquad, unsubscribeSquad } from '../api/squads'

/**
 * Watch a whole squad: subscribe to every work stream's lifecycle updates (current + future) and see
 * the squad's manager questions in your Action Center.
 */
export function SquadWatchButton({ squadId }: { squadId: string }) {
  const queryClient = useQueryClient()
  const { data } = useQuery(queries.squadSubscription.detail(squadId))
  const watching = data?.subscribed ?? false

  const mutation = useMutation({
    mutationFn: (subscribe: boolean) => (subscribe ? subscribeSquad(squadId) : unsubscribeSquad(squadId)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squadSubscription.detail(squadId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() })
    },
  })

  return (
    <button
      onClick={() => mutation.mutate(!watching)}
      disabled={mutation.isPending}
      title="Watch this squad to get its work-stream updates and questions"
      className={clsx(
        'tau-button',
        'px-2 py-0.5 rounded-md text-xs font-medium shrink-0',
        watching
          ? 'bg-surface-secondary text-secondary border border-th-border hover:bg-surface-hover'
          : 'bg-accent text-white hover:bg-accent-hover'
      )}
    >
      {watching ? 'Watching ✓' : 'Watch'}
    </button>
  )
}
