import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TrackedResourcesView } from '@tau/shared'
import { trackedResourceUrl } from '@tau/shared'
import { addWorkStreamTracked, removeWorkStreamTracked } from '../api/squads'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { Badge } from './Badge'
import { IssueIcon, PullRequestIcon } from './icons'

type TrackedRow = TrackedResourcesView['resources'][number]

/**
 * Why links exist but updates may not arrive. The delivery change request and
 * tracked links are followed by the same subscriptions, so one sentence covers
 * the whole section.
 */
const SUBSCRIPTION_HINTS: Record<Exclude<TrackedResourcesView['subscriptions'], 'active'>, string> = {
  'no-flow': 'Attach a workflow to receive updates',
  'not-following': 'This workflow does not follow code-host changes',
  ended: 'Work stream ended',
}

const resourceLabel = (resource: TrackedRow) => `${resource.repository}#${resource.number}`

/**
 * Issues and pull requests a work stream follows. Reference material (the
 * stream's `sources`) deliberately stays out — only links that can produce
 * updates belong here.
 */
export function WorkStreamTrackedResources({ workStreamId, canUpdate }: { workStreamId: string; canUpdate: boolean }) {
  const cache = useQueryClient()
  const [url, setUrl] = useState('')
  const { data } = useQuery(queries.squads.workStreamTracked(workStreamId))
  const invalidate = () => cache.invalidateQueries({ queryKey: queryKeys.squads.workStreamTracked(workStreamId) })
  const add = useMutation({
    mutationFn: (value: string) => addWorkStreamTracked(workStreamId, value),
    onSuccess: async () => {
      setUrl('')
      await invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (resource: TrackedRow) =>
      removeWorkStreamTracked(workStreamId, {
        integration: resource.integration,
        repository: resource.repository,
        kind: resource.kind,
        number: resource.number,
      }),
    onSuccess: async () => invalidate(),
  })
  const resources = data?.resources ?? []
  const hint = data && data.subscriptions !== 'active' ? SUBSCRIPTION_HINTS[data.subscriptions] : null
  const error = add.error ?? remove.error

  return (
    <section aria-label="Tracked issues and PRs" className="space-y-1.5">
      <h3 className="text-xs font-medium text-secondary">Tracked issues and PRs</h3>
      {resources.length > 0 && (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          {resources.map((resource) => {
            const href = trackedResourceUrl(resource)
            const label = resourceLabel(resource)
            const Icon = resource.kind === 'issue' ? IssueIcon : PullRequestIcon
            return (
              <li key={resource.key} className="flex items-center gap-1.5">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-accent hover:underline"
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    {label}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    {label}
                  </span>
                )}
                {resource.source === 'delivery' && <Badge color="purple">delivery</Badge>}
                {!resource.subscribed && <span className="text-muted">not subscribed</span>}
                {canUpdate && resource.source !== 'delivery' && (
                  <button
                    type="button"
                    aria-label={`Stop tracking ${label}`}
                    className="tau-button text-muted hover:text-primary"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(resource)}
                  >
                    Remove
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!resources.length && !canUpdate && <p className="text-xs text-muted">Nothing tracked</p>}
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {canUpdate && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const value = url.trim()
            if (value) add.mutate(value)
          }}
        >
          <input
            type="text"
            className="tau-field min-w-0 flex-1 px-2 py-1 text-xs"
            placeholder="https://github.com/owner/repo/issues/12"
            aria-label="Link to track"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" className="tau-button text-xs" disabled={add.isPending || !url.trim()}>
            Add
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error.message}
        </p>
      )}
    </section>
  )
}
