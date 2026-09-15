import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import type { AssistantActivityUpdate, AssistantTaskSummary } from '@tau/shared'
import { useStableRef } from '../hooks/useStableRef'
import {
  ASSISTANT_TASK_STATUS_LABELS,
  formatAssistantUpdateTime,
  shouldAcknowledgeAssistantUpdate,
} from '../lib/assistantActivityPresentation'
import { MarkdownContent } from './MarkdownContent'
import { ChevronRightIcon } from './icons'

export interface AssistantUpdateObserver {
  observe(element: Element): void
  unobserve(element: Element): void
  disconnect(): void
}
export type AssistantUpdateObserverFactory = (
  onChange: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void,
  root: Element | null
) => AssistantUpdateObserver | null

export interface AssistantUpdateListProps {
  updates: AssistantActivityUpdate[]
  tasks: AssistantTaskSummary[]
  /** The presentation surface is actually on screen; a hidden mounted panel never acknowledges. */
  visible: boolean
  /** Newest sequence the caller displayed; "Mark updates read" acknowledges through this snapshot only. */
  latestSequence: number
  hasMore: boolean
  onLoadMore?: () => Promise<void>
  onSeen: (messageIds: string[]) => Promise<void>
  onSeenThrough: (sequence: number) => Promise<void>
  /** Fires when the section opens or closes so the host can yield the chat area on narrow screens. */
  onExpandedChange?: (expanded: boolean) => void
  dependencies?: { createObserver?: AssistantUpdateObserverFactory; documentVisible?: () => boolean }
}

const SEEN_BATCH = 50

function defaultObserverFactory(
  onChange: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void,
  root: Element | null
): AssistantUpdateObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  return new IntersectionObserver((entries) => onChange(entries), { root, threshold: 0.5 })
}

/**
 * Durable raw update cards. Renders regardless of Realtime state so results stay readable while
 * catch-up is pending or a connection is unavailable. Acknowledgment happens only when a card
 * intersects the visible scroll viewport in a visible document, or through the explicit action.
 */
export function AssistantUpdateList(props: AssistantUpdateListProps) {
  const region = useRef<HTMLDivElement>(null)
  const intersecting = useRef(new Set<string>())
  const pendingSeen = useRef(new Set<string>())
  /** Acknowledged in this session; a slow refetch must not cause a second round-trip. */
  const acknowledged = useRef(new Set<string>())
  const [marking, setMarking] = useState(false)
  const [ackError, setAckError] = useState(false)
  // Collapsed by default so history does not repeat the transcript; unread updates open it, and an
  // explicit toggle wins until the next batch of unread updates arrives.
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)
  // Cards hidden with the per-card action stay out of view until the section is toggled again.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const propsRef = useStableRef(props)
  const documentVisible = props.dependencies?.documentVisible ?? (() => document.visibilityState === 'visible')
  const documentVisibleRef = useStableRef(documentVisible)
  const flush = useStableRef(async () => {
    const current = propsRef.current
    const seenIds = new Set(current.updates.filter((update) => update.seenAt).map((update) => update.messageId))
    const eligible = [...intersecting.current].filter(
      (id) =>
        !pendingSeen.current.has(id) &&
        shouldAcknowledgeAssistantUpdate({
          surfaceVisible: current.visible,
          documentVisible: documentVisibleRef.current(),
          intersects: true,
          alreadySeen: seenIds.has(id) || acknowledged.current.has(id),
        })
    )
    if (!eligible.length) return
    for (let index = 0; index < eligible.length; index += SEEN_BATCH) {
      const batch = eligible.slice(index, index + SEEN_BATCH)
      for (const id of batch) pendingSeen.current.add(id)
      try {
        await current.onSeen(batch)
        for (const id of batch) acknowledged.current.add(id)
        setAckError(false)
      } catch {
        // Unread counts are never cleared optimistically; the next intersection change retries.
        setAckError(true)
      } finally {
        for (const id of batch) pendingSeen.current.delete(id)
      }
    }
  })
  const unread = props.updates.filter((update) => !update.seenAt).length
  const previousUnread = useRef(unread)
  useEffect(() => {
    // New unread updates reopen a section the user had collapsed.
    if (unread > previousUnread.current) setExpandedOverride(null)
    previousUnread.current = unread
  }, [unread])
  const expanded = expandedOverride ?? unread > 0
  const onExpandedChange = useStableRef(props.onExpandedChange)
  useEffect(() => {
    onExpandedChange.current?.(expanded)
  }, [expanded, onExpandedChange])
  const hideCard = useStableRef(async (messageId: string) => {
    setHidden((current) => new Set([...current, messageId]))
    if (acknowledged.current.has(messageId) || pendingSeen.current.has(messageId)) return
    pendingSeen.current.add(messageId)
    try {
      await propsRef.current.onSeen([messageId])
      acknowledged.current.add(messageId)
      setAckError(false)
    } catch {
      setAckError(true)
      setHidden((current) => {
        const next = new Set(current)
        next.delete(messageId)
        return next
      })
    } finally {
      pendingSeen.current.delete(messageId)
    }
  })
  const createObserver = props.dependencies?.createObserver ?? defaultObserverFactory
  const shown = props.updates.filter((update) => !hidden.has(update.messageId))
  const updateIds = shown.map((update) => update.messageId).join(',')
  useEffect(() => {
    const root = region.current
    if (!root || !expanded) return
    const observer = createObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.updateId
        if (!id) continue
        if (entry.isIntersecting) intersecting.current.add(id)
        else intersecting.current.delete(id)
      }
      void flush.current()
    }, root)
    if (!observer) return
    for (const card of root.querySelectorAll<HTMLElement>('[data-update-id]')) observer.observe(card)
    return () => {
      observer.disconnect()
      intersecting.current.clear()
    }
    // Re-observe when the set of rendered cards changes or the section opens.
  }, [createObserver, flush, updateIds, expanded])
  useEffect(() => {
    // Becoming visible (panel shown, tab focused) reconsiders cards already in view.
    const onVisibility = () => void flush.current()
    document.addEventListener('visibilitychange', onVisibility)
    if (props.visible) void flush.current()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [props.visible, flush])
  const taskById = new Map(props.tasks.map((task) => [task.id, task]))
  return (
    <section
      aria-label="Task updates"
      data-expanded={expanded || undefined}
      // Open on a phone, the list takes the chat area (the host hides the transcript); on wider
      // screens it keeps a bounded height and scrolls so the transcript stays in view.
      className={clsx('flex min-h-0 flex-col border-t border-th-border', expanded && 'flex-1 md:flex-none')}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="assistant-task-updates"
          className="tau-button flex min-w-0 items-center gap-1.5 rounded-md py-1 pl-1 pr-2 text-muted hover:text-primary"
          onClick={() => {
            setExpandedOverride(!expanded)
            setHidden(new Set())
          }}
        >
          <ChevronRightIcon
            className={clsx(
              'h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
          <h3 className="font-medium">Updates</h3>
          <span className="text-muted">
            {unread > 0 ? `${unread} unread` : `${props.updates.length}${props.hasMore ? '+' : ''}`}
          </span>
        </button>
        {ackError && (
          <span role="status" className="text-muted">
            Read state could not be saved. Retrying…
          </span>
        )}
        {unread > 0 && (
          <button
            type="button"
            disabled={marking}
            className="tau-button ml-auto py-1 text-xs text-accent-light disabled:opacity-40"
            onClick={async () => {
              setMarking(true)
              try {
                await props.onSeenThrough(props.latestSequence)
                setAckError(false)
              } catch {
                setAckError(true)
              } finally {
                setMarking(false)
              }
            }}
          >
            Mark updates read
          </button>
        )}
      </div>
      <div
        id="assistant-task-updates"
        ref={region}
        hidden={!expanded}
        className={clsx(
          'min-h-0 overflow-y-auto overscroll-contain px-2 pb-2',
          expanded && 'flex-1 md:max-h-80 md:flex-none'
        )}
      >
        {props.hasMore && props.onLoadMore && (
          <button
            type="button"
            className="tau-button w-full py-1.5 text-xs text-muted"
            onClick={() => void props.onLoadMore?.()}
          >
            Load earlier updates
          </button>
        )}
        {shown.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted">
            {props.updates.length === 0 ? 'No task updates yet. Delegated tasks report here.' : 'All caught up.'}
          </p>
        )}
        <ul className="space-y-1">
          {shown.map((update) => {
            const task = update.taskId ? taskById.get(update.taskId) : undefined
            const status = update.reportedStatus ? ASSISTANT_TASK_STATUS_LABELS[update.reportedStatus] : undefined
            return (
              <li
                key={update.messageId}
                data-update-id={update.messageId}
                data-unread={update.seenAt ? undefined : 'true'}
                className={clsx('rounded-xl px-3 py-2 text-sm', !update.seenAt && 'bg-selection')}
              >
                <div className="flex items-center gap-2 text-xs text-muted">
                  {!update.seenAt && (
                    <span aria-label="Unread" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  )}
                  {task && <span className="truncate font-medium text-primary">{task.label}</span>}
                  {status && <span className="shrink-0">{status}</span>}
                  <span className="ml-auto shrink-0">
                    {update.senderName} · {formatAssistantUpdateTime(update.createdAt)}
                  </span>
                  {!update.seenAt && (
                    <button
                      type="button"
                      aria-label="Hide update"
                      title="Mark read and hide until the section is reopened"
                      className="tau-button -my-1 shrink-0 rounded-md px-1.5 py-1 text-accent-light hover:bg-selection"
                      onClick={() => void hideCard.current(update.messageId)}
                    >
                      Hide
                    </button>
                  )}
                </div>
                {update.subject && <p className="mt-1 font-medium">{update.subject}</p>}
                <MarkdownContent className="mt-1 text-sm">{update.content}</MarkdownContent>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
