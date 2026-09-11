import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { updateMyNotificationPrefs } from '../../api/config'

function humanizeEvent(event: string): string {
  const labels: Record<string, string> = {
    'agent-question.created': 'Agent questions',
    'inbox.messageReceived': 'Inbox messages (including work streams you watch)',
  }
  return labels[event] ?? event
}

/**
 * Per-user notification preferences (self-service): a master push toggle and per-event mutes.
 * These apply to the user's account across all of their devices; device registration is separate.
 */
export function NotificationPreferences() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery(queries.notificationConfig.mine())

  const mutation = useMutation({
    mutationFn: (input: { pushEnabled?: boolean; mutedEvents?: string[] }) => updateMyNotificationPrefs(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notificationConfig.mine() }),
  })

  if (isLoading || !data) return null

  const { pushEnabled } = data
  const muted = new Set(data.mutedEvents)

  const toggleEvent = (event: string) => {
    const next = new Set(muted)
    if (next.has(event)) next.delete(event)
    else next.add(event)
    mutation.mutate({ mutedEvents: [...next] })
  }

  return (
    <div className="tau-section py-5">
      <h4 className="text-md font-medium text-primary mb-1">Notification preferences</h4>
      <p className="text-sm text-muted mb-4">
        Control which notifications are pushed to you. These apply to your account across all your devices.
      </p>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <p className="font-medium text-primary">Push notifications</p>
          <p className="text-sm text-muted">Master switch for push to your account. Turn off to stop all push.</p>
        </div>
        <button
          onClick={() => mutation.mutate({ pushEnabled: !pushEnabled })}
          disabled={mutation.isPending}
          className={clsx(
            'tau-button',
            'px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
            pushEnabled
              ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/50'
              : 'bg-accent text-white hover:bg-accent-hover'
          )}
        >
          {pushEnabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      {pushEnabled && data.pushEvents.length > 0 && (
        <div className="mt-5">
          <p className="text-sm font-medium text-secondary mb-2">Notify me about</p>
          <ul className="space-y-2">
            {data.pushEvents.map((event) => (
              <li key={event} className="flex items-center justify-between gap-3">
                <span className="text-sm text-primary">{humanizeEvent(event)}</span>
                <input
                  type="checkbox"
                  checked={!muted.has(event)}
                  onChange={() => toggleEvent(event)}
                  disabled={mutation.isPending}
                  className="h-4 w-4 shrink-0"
                  aria-label={`Notify about ${humanizeEvent(event)}`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
