import { useEffect, useRef, useState } from 'react'
import { useQuery, useInfiniteQuery } from '../reactQueryHooks'
import type { PendingAction } from '@tau/shared'
import { acknowledgeFeedVisit, type FeedVisit } from '../api/auth'
import { feedQueries, queries } from '../queryOptions'
import { usePermissions } from '../hooks/usePermissions'
import { Link, useLocation } from 'react-router-dom'
import { ChevronRightIcon } from './icons'
import { ActionCenterContent } from './ActionCenterContent'

export function FeedVisitSummary({ actions, ready }: { actions: PendingAction[]; ready: boolean }) {
  const { identity } = usePermissions()
  return identity?.type === 'user' ? (
    <AccountFeedVisit key={identity.userId} userId={identity.userId} actions={actions} ready={ready} />
  ) : null
}

export function AccountFeedVisit({
  userId,
  actions,
  ready,
  acknowledge = acknowledgeFeedVisit,
  ActionCenter = ActionCenterContent,
}: {
  userId: string
  actions: PendingAction[]
  ready: boolean
  acknowledge?: typeof acknowledgeFeedVisit
  ActionCenter?: typeof ActionCenterContent
}) {
  const location = useLocation()
  const visit = useQuery(feedQueries.visit(userId))
  const work = useQuery(queries.squads.activeWorkStreams())
  const [snapshot, setSnapshot] = useState<FeedVisit | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const acknowledged = useRef(false)
  useEffect(() => {
    // Do not use another mount/device's cached watermark or change this visit's
    // baseline when a background refresh returns a newer account timestamp.
    if (visit.isSuccess && visit.isFetchedAfterMount) setSnapshot((current) => current ?? visit.data)
  }, [visit.isSuccess, visit.isFetchedAfterMount, visit.data])
  const completed = useInfiniteQuery({
    ...feedQueries.completed(snapshot?.lastVisitedAt ?? '', snapshot?.observedAt ?? ''),
    enabled: Boolean(snapshot?.lastVisitedAt),
  })
  const loaded = ready && work.isSuccess && snapshot && (!snapshot.lastVisitedAt || completed.isSuccess)
  useEffect(() => {
    if (!loaded || !snapshot || acknowledged.current) return
    const save = () => {
      if (document.visibilityState === 'hidden' || acknowledged.current) return
      acknowledged.current = true
      void acknowledge(snapshot.observedAt).catch(() => {
        // Keep the old account watermark on failure; never claim unseen work was read.
        acknowledged.current = false
      })
    }
    save()
    document.addEventListener('visibilitychange', save)
    return () => document.removeEventListener('visibilitychange', save)
  }, [loaded, snapshot, acknowledge])

  if (dismissed || !snapshot?.lastVisitedAt || !completed.data || !ready) return null
  const since = Date.parse(snapshot.lastVisitedAt)
  const until = Date.parse(snapshot.observedAt)
  const newActions = actions.filter((action) => {
    const created = Date.parse(action.createdAt)
    return created > since && created <= until
  })
  const totalCount = completed.data.pages[0]?.totalCount ?? 0
  const streams = completed.data.pages.flatMap((page) => page.items)
  const parts = [
    totalCount ? `${totalCount} completed` : '',
    newActions.length ? `${newActions.length} ${newActions.length === 1 ? 'needs' : 'need'} your input` : '',
  ].filter(Boolean)
  if (!parts.length) return null
  return (
    <details open className="mb-4 group" data-testid="feed-visit-summary">
      <summary className="tau-button flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-2 text-left hover:bg-surface-hover marker:hidden [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="shrink-0 text-placeholder transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold text-secondary">Since your last visit</span>
        <span className="text-xs text-muted">{parts.join(' · ')}</span>
        <button
          type="button"
          className="tau-button ml-auto shrink-0 rounded px-2 py-1 text-xs text-muted hover:text-primary"
          aria-label="Dismiss updates since your last visit"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setDismissed(true)
          }}
        >
          Dismiss
        </button>
      </summary>
      <div className="space-y-3 pb-3 pt-3">
        {streams.length > 0 && (
          <ul className="space-y-1">
            {streams.map((stream) => {
              const params = new URLSearchParams(location.search)
              params.set('ws', stream.id)
              return (
                <li key={stream.id}>
                  <Link
                    to={{ pathname: location.pathname, search: params.toString() }}
                    className="flex items-start gap-2 rounded-lg py-2.5 pl-6 pr-3 hover:bg-surface-hover"
                  >
                    <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-green-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-primary break-words">{stream.title}</span>
                      <span className="mt-1 block text-xs text-muted">
                        Completed
                        {stream.completedAt && (
                          <>
                            {' '}
                            ·{' '}
                            <time dateTime={new Date(stream.completedAt).toISOString()}>
                              {new Date(stream.completedAt).toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </time>
                          </>
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
        {completed.hasNextPage && (
          <button
            className="tau-button ml-6 text-xs text-muted"
            disabled={completed.isFetchingNextPage}
            onClick={() => void completed.fetchNextPage()}
          >
            {completed.isFetchingNextPage ? 'Loading…' : 'Show more updates'}
          </button>
        )}
        {completed.isFetchNextPageError && (
          <p role="alert" className="ml-6 text-sm text-danger">
            Could not load more updates. Try again.
          </p>
        )}
        {newActions.length > 0 && <ActionCenter actions={newActions} isLoading={false} />}
      </div>
    </details>
  )
}
