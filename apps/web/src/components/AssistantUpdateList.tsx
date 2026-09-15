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
  const createObserver = props.dependencies?.createObserver ?? defaultObserverFactory
  const updateIds = props.updates.map((update) => update.messageId).join(',')
  useEffect(() => {
    const root = region.current
    if (!root) return
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
    // Re-observe when the set of rendered cards changes.
  }, [createObserver, flush, updateIds])
  useEffect(() => {
    // Becoming visible (panel shown, tab focused) reconsiders cards already in view.
    const onVisibility = () => void flush.current()
    document.addEventListener('visibilitychange', onVisibility)
    if (props.visible) void flush.current()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [props.visible, flush])
  const unread = props.updates.filter((update) => !update.seenAt).length
  const taskById = new Map(props.tasks.map((task) => [task.id, task]))
  return (
    <section aria-label="Task updates" className="flex min-h-0 flex-col border-t border-th-border">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs">
        <h3 className="font-medium text-muted">Updates</h3>
        {unread > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-[10px] font-medium text-white">{unread} unread</span>
        )}
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
      <div ref={region} className="min-h-0 max-h-64 overflow-y-auto overscroll-contain px-2 pb-2">
        {props.hasMore && props.onLoadMore && (
          <button
            type="button"
            className="tau-button w-full py-1.5 text-xs text-muted"
            onClick={() => void props.onLoadMore?.()}
          >
            Load earlier updates
          </button>
        )}
        {props.updates.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted">No task updates yet. Delegated tasks report here.</p>
        )}
        <ul className="space-y-1">
          {props.updates.map((update) => {
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
