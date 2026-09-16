import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ATTENTION_LEVELS,
  DEFAULT_ATTENTION,
  summarizeAttention,
  type Attention,
  type AttentionKind,
  type AttentionLevel,
} from '@tau/shared'
import { queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import {
  subscribeSquad,
  subscribeWorkStream,
  unsubscribeSquad,
  unsubscribeWorkStream,
  type SquadSubscription,
  type WorkStreamSubscription,
} from '../api/squads'
import { BellCheckIcon, BellIcon, SpeakerOffIcon } from './icons'

export type AttentionTarget = { kind: 'squad'; id: string } | { kind: 'workStream'; id: string }

const KIND_COPY: Record<AttentionKind, { label: string; helper: string }> = {
  decisions: { label: 'Decisions', helper: 'Questions, reviews, and blockers' },
  progress: { label: 'Progress', helper: 'Active work and completions' },
}

const LEVEL_LABEL: Record<AttentionLevel, string> = { mute: 'Mute', show: 'Show', notify: 'Notify' }

// The radio itself is `sr-only`, and `clip: rect(0,0,0,0)` would clip its focus outline away, so
// the visible label wears the ring while the hidden input holds the keyboard focus.
const LABEL_FOCUS_RING =
  'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus'

const SUMMARY_LABEL: Record<AttentionLevel | 'custom', string> = {
  notify: 'Notify',
  show: 'Show',
  mute: 'Muted',
  custom: 'Custom',
}

function SummaryIcon({ summary }: { summary: AttentionLevel | 'custom' }) {
  if (summary === 'mute') return <SpeakerOffIcon className="h-4 w-4" />
  if (summary === 'notify') return <BellCheckIcon className="h-4 w-4" />
  return <BellIcon className="h-4 w-4" />
}

/**
 * Per-squad and per-work-stream attention. Two independent kinds, one three-point scale each:
 * Mute (not even listed), Show (listed, never interrupts), Notify (inbox message + push). A work
 * stream with no row of its own inherits the squad's levels; "Reset to squad" deletes the row.
 */
export function AttentionMenu({ target, className }: { target: AttentionTarget; className?: string }) {
  const queryClient = useQueryClient()
  const isSquad = target.kind === 'squad'
  // Two typed queries with a constant hook order, rather than one query whose options type would
  // be a union: only the one matching this target is enabled, so only it ever fetches.
  const squadQuery = useQuery({ ...queries.squadSubscription.detail(target.id), enabled: isSquad })
  const streamQuery = useQuery({ ...queries.workStreamSubscription.detail(target.id), enabled: !isSquad })
  const data: SquadSubscription | WorkStreamSubscription | undefined = isSquad ? squadQuery.data : streamQuery.data
  const attention: Attention = data?.attention ?? DEFAULT_ATTENTION
  // Until the stream's own row loads, claim neither inheritance nor an override: guessing one
  // flashes "Inherits from squad" on a stream that in fact has its own levels.
  const inheritance = isSquad || !streamQuery.data ? null : streamQuery.data.inherited ? 'squad' : 'own'
  const summary = summarizeAttention(attention)

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: isSquad
        ? queryKeys.squadSubscription.detail(target.id)
        : queryKeys.workStreamSubscription.detail(target.id),
    })
    queryClient.invalidateQueries({ queryKey: queryKeys.actions.pending() })
    queryClient.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreamsPrefix() })
  }

  const mutation = useMutation({
    mutationFn: (next: Attention | null) => {
      if (next === null) return isSquad ? unsubscribeSquad(target.id) : unsubscribeWorkStream(target.id)
      return isSquad ? subscribeSquad(target.id, next) : subscribeWorkStream(target.id, next)
    },
    onSuccess: invalidate,
  })

  const setLevel = (kind: AttentionKind, level: AttentionLevel) => mutation.mutate({ ...attention, [kind]: level })

  return (
    <details className={clsx('attention-menu relative', className)}>
      <summary
        title="Choose what this notifies you about"
        className="tau-button inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium text-secondary hover:bg-surface-hover"
      >
        <SummaryIcon summary={summary} />
        <span>{SUMMARY_LABEL[summary]}</span>
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-th-border bg-surface-primary p-3 shadow-lg">
        {(Object.keys(KIND_COPY) as AttentionKind[]).map((kind) => (
          <div key={kind} className="mb-3 last:mb-0">
            <p className="text-xs font-medium text-primary">{KIND_COPY[kind].label}</p>
            <p className="mb-1 text-xs text-muted">{KIND_COPY[kind].helper}</p>
            <div
              role="radiogroup"
              aria-label={KIND_COPY[kind].label}
              aria-busy={mutation.isPending}
              className={clsx('flex gap-1', mutation.isPending && 'opacity-60')}
            >
              {ATTENTION_LEVELS.map((level) => (
                <label
                  key={level}
                  className={clsx(
                    'flex-1 cursor-pointer rounded border border-th-border px-2 py-1 text-center text-xs',
                    LABEL_FOCUS_RING,
                    attention[kind] === level ? 'bg-accent text-white' : 'text-secondary hover:bg-surface-hover'
                  )}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${target.kind}-${target.id}-${kind}`}
                    aria-label={`${KIND_COPY[kind].label}: ${LEVEL_LABEL[level]}`}
                    checked={attention[kind] === level}
                    onChange={() => setLevel(kind, level)}
                  />
                  {LEVEL_LABEL[level]}
                </label>
              ))}
            </div>
          </div>
        ))}
        {inheritance === 'squad' && <p className="text-xs text-muted">Inherits from squad</p>}
        {inheritance === 'own' && (
          <button
            type="button"
            onClick={() => mutation.mutate(null)}
            disabled={mutation.isPending}
            className="tau-button text-xs text-accent hover:underline"
          >
            Reset to squad
          </button>
        )}
        {mutation.isError && (
          <p role="alert" className="mt-2 text-xs text-danger">
            Could not update attention. Try again.
          </p>
        )}
      </div>
    </details>
  )
}
