import clsx from 'clsx'
import { assistantConversationLink, type AssistantConversationLink } from '../lib/assistantConversationLinks'
import { AssistantConversationLinkRow } from './AssistantConversationLinkRow'
import { siteAssistantToolRenderers, type ToolRenderers } from '../lib/tool-renderers'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantActivityUpdate, AssistantEntry, AssistantMessageReceipt } from '@tau/shared'
import { useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { assistantApi } from '../api/assistant'
import { assistantQueryKeys } from '../queryKeys'
import { assistantQueries } from '../queryOptions'
import { useStableRef } from '../hooks/useStableRef'
import { useAssistantActivity } from '../hooks/useAssistantActivity'
import { useAssistantInboxConsumer } from '../hooks/useAssistantInboxConsumer'
import { AssistantUpdateList } from './AssistantUpdateList'
import { AssistantConversationContext, type AssistantConversationBridge } from '../voice/AssistantConversationContext'
import { siteOperatorVoiceAssistant } from '../voice/assistants/siteOperator/siteOperatorAssistant'
import { useRealtimeVoiceAssistant } from '../voice/useRealtimeVoiceAssistant'
import { summarizeAssistantError } from '../voice/assistantErrorPresentation'
import { isRecoverableVoiceConnectionError } from '../voice/voiceConnectionErrors'
import { VoiceTranscriptInspector } from '../voice/VoiceTranscriptInspector'
import { VoiceCompanionButton } from '../voice/VoiceCompanionWidget'
import type { PageEditorBridge } from '../voice/AssistantConversationContext'
import type { VoiceTranscriptEntry } from '../voice/types'

export interface AssistantViewControls {
  startVoice: () => Promise<void>
  live: boolean
  connecting: boolean
  connectionFailed?: boolean
}

export function AssistantConversationView(props: {
  id: string
  onOpenConversation?: (conversation: AssistantConversationLink) => void
  pageEditor?: PageEditorBridge
  toolRenderers?: ToolRenderers
  existing?: boolean
  realtime: boolean
  initialMessage?: { id: string; text: string }
  compact: boolean
  visible: boolean
  onControls: (controls: AssistantViewControls) => void
  onCreated: (id: string) => void
  onExpand: () => void
  positionControl: React.ReactNode
  dependencies?: { api?: typeof assistantApi; useAssistant?: typeof useRealtimeVoiceAssistant }
}) {
  const pageEditor = useStableRef(props.pageEditor)
  const pagePath = useStableRef(useLocation().pathname)
  const api = props.dependencies?.api ?? assistantApi
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState<AssistantEntry[]>([])
  const [ready, setReady] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [before, setBefore] = useState<number>()
  const [hasMore, setHasMore] = useState(false)
  const known = useRef(new Map<string, boolean>())
  const ensurePromise = useRef<Promise<VoiceTranscriptEntry[]> | null>(null)
  const writes = useRef<Promise<unknown>>(Promise.resolve())
  const pendingEntries = useRef(new Map<string, AssistantEntry>())
  const onCreated = useStableRef(props.onCreated)
  const savedRef = useStableRef(saved)
  const ensure = useCallback(async () => {
    if (!ensurePromise.current)
      ensurePromise.current = (async () => {
        await pageEditor.current?.prepare()
        if (!props.existing) await api.create(props.id, props.initialMessage?.text.slice(0, 120))
        const data = await api.history(props.id)
        for (const entry of data.entries) known.current.set(entry.id, entry.final)
        setSaved(data.entries)
        setReady(true)
        setBefore(data.before)
        setHasMore(data.hasMore)
        onCreated.current(props.id)
        void queryClient.invalidateQueries({ queryKey: assistantQueryKeys.all })
        return data.entries
      })().catch((error) => {
        ensurePromise.current = null
        throw error
      })
    await ensurePromise.current
    return savedRef.current.length ? savedRef.current : ensurePromise.current
  }, [api, onCreated, props.id, props.initialMessage?.text, props.existing, queryClient, savedRef, pageEditor])
  useEffect(() => {
    if (props.existing || props.pageEditor) void ensure().catch(() => setSaveError('Conversation could not be loaded.'))
  }, [props.existing, props.pageEditor, ensure])
  const append = useCallback(
    async (entries: AssistantEntry[]) => {
      for (const entry of entries) {
        const previous = pendingEntries.current.get(entry.id)
        if (!previous?.final) pendingEntries.current.set(entry.id, entry)
      }
      const operation = writes.current
        .catch(() => {})
        .then(async () => {
          await ensure()
          const fresh = [...pendingEntries.current.values()].filter(
            (entry) => !known.current.has(entry.id) || (!known.current.get(entry.id) && entry.final)
          )
          if (!fresh.length) return
          for (let i = 0; i < fresh.length; i += 50) await api.append(props.id, fresh.slice(i, i + 50))
          for (const entry of fresh) {
            known.current.set(entry.id, entry.final)
            if (pendingEntries.current.get(entry.id) === entry) pendingEntries.current.delete(entry.id)
          }
          setSaved((current) => [
            ...current.map((entry) => fresh.find((update) => update.id === entry.id) ?? entry),
            ...fresh.filter((entry) => !current.some((existing) => existing.id === entry.id)),
          ])
          setSaveError(undefined)
          void queryClient.invalidateQueries({ queryKey: assistantQueryKeys.all })
        })
      writes.current = operation
      try {
        await operation
      } catch (error) {
        setSaveError('Conversation could not be saved. Retry before leaving this page.')
        throw error
      }
    },
    [api, ensure, props.id, queryClient]
  )
  const pendingMessages = useRef(new Map<string, string>())
  const sendAgent = useCallback(
    async (
      request: string,
      target: { agentId?: string; squadId?: string; label?: string },
      mode: 'steer' | 'follow-up' = 'steer',
      inReplyTo?: string
    ) => {
      await ensure()
      await pageEditor.current?.prepare()
      await writes.current
      const key = JSON.stringify([target.agentId, target.squadId, request, mode, inReplyTo])
      const clientId = pendingMessages.current.get(key) ?? crypto.randomUUID()
      pendingMessages.current.set(key, clientId)
      const receipt = await api.message(props.id, request, clientId, {
        agentId: target.agentId,
        squadId: target.squadId,
        label: target.label,
        mode,
        inReplyTo,
        pagePath: pagePath.current,
      })
      pendingMessages.current.delete(key)
      return {
        ...receipt,
        conversation: {
          agentId: receipt.agentId,
          ...(receipt.squadId ? { squadId: receipt.squadId } : {}),
          label: receipt.kind === 'agent' ? 'Agent conversation' : (target.label ?? 'Background task'),
          kind: receipt.kind,
        },
      }
    },
    [api, ensure, props.id, pagePath, pageEditor]
  )
  const bridge = useMemo<AssistantConversationBridge>(
    () => ({
      pageEditor: props.pageEditor,
      openConversation: props.onOpenConversation,
      prepareHistory: async () => {
        await ensure()
        await writes.current.catch(() => {})
        const fresh = await api.history(props.id)
        for (const entry of fresh.entries) known.current.set(entry.id, entry.final)
        setSaved(fresh.entries)
        return fresh.entries
      },
      delegateTask: (request, options) =>
        sendAgent(request, { squadId: options.squadId, label: options.label }, options.mode, options.inReplyTo),
      messageAgent: (agentId, request, mode, inReplyTo) => sendAgent(request, { agentId }, mode, inReplyTo),
    }),
    [api, props.id, ensure, sendAgent, props.pageEditor, props.onOpenConversation]
  )
  return (
    <AssistantConversationContext.Provider value={bridge}>
      <ConversationRuntime
        {...props}
        saveError={saveError}
        saved={saved}
        ready={ready}
        append={append}
        ensure={ensure}
        sendAgent={sendAgent}
      />
      {props.visible && !props.compact && (
        <>
          {saveError && (
            <p role="alert" className="px-4 py-2 text-sm text-red-500">
              {saveError}
            </p>
          )}
          {hasMore && (
            <button
              className="tau-button text-xs text-muted px-4 py-2"
              onClick={async () => {
                const data = await api.history(props.id, before)
                setSaved([
                  ...data.entries.filter((e) => !savedRef.current.some((row) => row.id === e.id)),
                  ...savedRef.current,
                ])
                setBefore(data.before)
                setHasMore(data.hasMore)
              }}
            >
              Load earlier messages
            </button>
          )}
        </>
      )}
    </AssistantConversationContext.Provider>
  )
}

function ConversationRuntime(
  props: Parameters<typeof AssistantConversationView>[0] & {
    saveError?: string
    saved: AssistantEntry[]
    ready: boolean
    ensure: () => Promise<VoiceTranscriptEntry[]>
    append: (entries: AssistantEntry[]) => Promise<void>
    sendAgent: (
      request: string,
      target: { agentId?: string; squadId?: string; label?: string },
      mode?: 'steer' | 'follow-up',
      inReplyTo?: string
    ) => Promise<AssistantMessageReceipt>
  }
) {
  const voice = (props.dependencies?.useAssistant ?? useRealtimeVoiceAssistant)(siteOperatorVoiceAssistant, {
    textOnly: true,
    autoReconnect: true,
    maxReconnectAttempts: 3,
  })
  const voiceRef = useStableRef(voice)
  useEffect(() => {
    if (props.pageEditor && !props.realtime) voiceRef.current.disconnect()
  }, [props.pageEditor, props.realtime, voiceRef])
  const api = props.dependencies?.api ?? assistantApi
  const [awaitingReplies, setAwaitingReplies] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const [mailboxError, setMailboxError] = useState(false)
  const documentVisible = useDocumentVisible()
  const propsRef = useStableRef(props)
  // Only an active, visible presentation consumes the mailbox: the open text conversation, or a
  // connected Realtime session that is visible or carrying live voice. Badges never claim a lease.
  const consumerEnabled =
    props.ready &&
    documentVisible &&
    (props.realtime ? voice.isConnected && (props.visible || voice.isLiveAudio) : props.visible)
  useAssistantInboxConsumer({
    conversationId: props.id,
    enabled: consumerEnabled,
    realtime: props.realtime,
    api,
    append: (entries) => propsRef.current.append(entries),
    present: (batch, entry) =>
      new Promise<void>((resolve) => {
        voiceRef.current.enqueueMessage({
          id: entry.id,
          historyEntry: entry,
          disableMic: false,
          text: batch.text,
          onDone: () => resolve(),
          // The entry is already durable and final; an interrupted announcement is still complete.
          onCancel: () => resolve(),
        })
      }),
    onMailbox: (mailbox) => {
      setAwaitingReplies(mailbox.pending)
      setUnavailable(mailbox.unavailable)
    },
    onError: setMailboxError,
  })
  // Durable task updates are readable independently of Realtime and of the mailbox consumer.
  const { ownerId } = useAssistantActivity({ enabled: false })
  const activity = useQuery({
    ...assistantQueries.conversationActivity(ownerId ?? '', props.id),
    queryFn: () => api.conversationActivity(props.id),
    enabled: Boolean(ownerId) && props.ready,
  })
  const [olderUpdates, setOlderUpdates] = useState<AssistantActivityUpdate[]>([])
  const [olderCursor, setOlderCursor] = useState<number | null>()
  const queryClientForActivity = useQueryClient()
  const refreshActivity = useCallback(
    () => queryClientForActivity.invalidateQueries({ queryKey: assistantQueryKeys.activityPrefix }),
    [queryClientForActivity]
  )
  const latestUpdates = activity.data?.updates ?? []
  const oldestLoaded = olderCursor === undefined ? (activity.data?.beforeSequence ?? null) : olderCursor
  const shownUpdates = [
    ...olderUpdates.filter((update) => !latestUpdates.some((latest) => latest.messageId === update.messageId)),
    ...latestUpdates,
  ]
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ text: string; previousIds: Set<string | undefined> }>()
  const [error, setError] = useState<string>()
  const [startingVoice, setStartingVoice] = useState(false)
  const sentInitial = useRef<string | undefined>(undefined)
  const transcript = useRef<HTMLDivElement>(null)
  const followTranscript = useRef(true)
  const useRealtime = props.realtime
  const savedIds = new Set(props.saved.map((entry) => entry.id))
  const history = [
    ...props.saved.map((entry) => voice.history.find((live) => live.id === entry.id) ?? entry),
    ...voice.history.filter((entry) => !savedIds.has(entry.id ?? '')),
  ]
  const latestHistory = useStableRef(history)
  const pendingVisible =
    pending &&
    !history.some((entry) => entry.role === 'user' && entry.text === pending.text && !pending.previousIds.has(entry.id))
  const activityLabel =
    useRealtime &&
    (voice.isReconnecting || voice.status === 'connecting' || startingVoice || (busy && !voice.isConnected))
      ? voice.isReconnecting
        ? voice.pendingTextCount
          ? 'Reconnecting… Your message will resume automatically.'
          : 'Reconnecting…'
        : 'Connecting…'
      : error
        ? undefined
        : awaitingReplies > 0
          ? unavailable
            ? 'A background task lost its helper. Start it again if it matters.'
            : awaitingReplies === 1
              ? 'Working in the background…'
              : `Working on ${awaitingReplies} background tasks…`
          : busy && !useRealtime
            ? 'Working on your request…'
            : voice.status === 'processing'
              ? 'Thinking…'
              : voice.status === 'speaking'
                ? 'Responding…'
                : busy
                  ? 'Sending…'
                  : undefined
  const appendRef = useStableRef(props.append)
  useEffect(() => {
    // Reserve an entry's position immediately; write its completed content once. Never replay saved tools.
    const entries = voice.history.filter((entry): entry is AssistantEntry => Boolean(entry.id))
    if (entries.length) void appendRef.current(entries).catch(() => {})
  }, [voice.history, appendRef])
  useEffect(() => {
    const container = transcript.current
    if (props.visible && container && followTranscript.current) container.scrollTop = container.scrollHeight
  }, [voice.history, props.saved, props.visible, activityLabel, pendingVisible])
  const startVoice = useCallback(async () => {
    setStartingVoice(true)
    setError(undefined)
    try {
      await voiceRef.current.setLiveAudio(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Voice could not start')
    } finally {
      setStartingVoice(false)
    }
  }, [voiceRef])
  const connectionFailed =
    Boolean(voice.error) && !voice.isConnected && !voice.isReconnecting && voice.status !== 'connecting'
  const onControls = useStableRef(props.onControls)
  useEffect(() => {
    onControls.current({ startVoice, live: voice.isLiveAudio, connecting: startingVoice, connectionFailed })
  }, [startVoice, voice.isLiveAudio, startingVoice, connectionFailed, onControls])
  const send = async (text: string) => {
    if (!text.trim() || busy) return
    followTranscript.current = true
    setBusy(true)
    setPending({ text, previousIds: new Set(history.map((entry) => entry.id)) })
    setDraft('')
    setError(undefined)
    try {
      await props.ensure()
      await props.pageEditor?.prepare()
      if (useRealtime) {
        const context = props.pageEditor?.getContext?.()
        if (context) await voice.sendText(text, context)
        else await voice.sendText(text)
      } else {
        await props.append([{ id: crypto.randomUUID(), role: 'user', text, final: true, channel: 'text' }])
        // No label: a typed message is not a new task, so it must not rewrite the helper's purpose.
        await props.sendAgent(text, {})
        setAwaitingReplies((count) => count + 1)
      }
      setDraft('')
      setPending(undefined)
    } catch (error) {
      setDraft(text)
      setError(error instanceof Error ? error.message : 'Message could not be sent')
    } finally {
      setBusy(false)
    }
  }
  const sendRef = useStableRef(send)
  useEffect(() => {
    if (!props.initialMessage || sentInitial.current === props.initialMessage.id) return
    sentInitial.current = props.initialMessage.id
    void sendRef.current(props.initialMessage.text)
  }, [props.initialMessage, sendRef])
  const controlsOnlyVoice = () => ({
    ...voice,
    isConnected: voice.isLiveAudio,
    status: startingVoice ? ('connecting' as const) : voice.status,
    toggle: () => {
      void voice.setLiveAudio(false)
    },
  })
  return (
    <div className="flex flex-1 min-h-0 flex-col" style={{ display: props.visible ? undefined : 'none' }}>
      {voice.isLiveAudio && (
        <VoiceCompanionButton
          embedded
          controlsOnly
          compactOverride={props.compact}
          onExpand={props.onExpand}
          positionControl={props.positionControl}
          dependencies={{ useVoiceAssistant: controlsOnlyVoice }}
        />
      )}
      {!props.compact && (
        <>
          <div
            ref={transcript}
            onScroll={(event) => {
              const container = event.currentTarget
              followTranscript.current = container.scrollHeight - container.scrollTop - container.clientHeight < 48
            }}
            className={clsx('min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain', !props.pageEditor && 'px-2')}
            aria-label="Assistant conversation"
          >
            <VoiceTranscriptInspector
              renderEntryFooter={
                props.onOpenConversation
                  ? (entry) => {
                      const conversation = assistantConversationLink(entry)
                      return conversation ? (
                        <AssistantConversationLinkRow conversation={conversation} onOpen={props.onOpenConversation!} />
                      ) : null
                    }
                  : undefined
              }
              alignContent={!!props.pageEditor}
              history={
                pendingVisible
                  ? [...history, { id: 'pending-send', role: 'user', text: pending.text, final: false }]
                  : history
              }
              activityLabel={activityLabel}
              toolRenderers={props.toolRenderers ?? siteAssistantToolRenderers}
              emptyLabel={
                props.realtime ? (
                  <>
                    {props.pageEditor ? 'Describe your flow' : 'Ask anything'}, or{' '}
                    {voice.isLiveAudio ? (
                      'speak to the assistant.'
                    ) : (
                      <>
                        <button
                          type="button"
                          className="tau-button text-accent-light underline underline-offset-2 disabled:opacity-50"
                          disabled={Boolean(props.pageEditor && !props.ready) || startingVoice}
                          onClick={() => void startVoice()}
                        >
                          {startingVoice ? 'connecting your microphone…' : 'enable your microphone'}
                        </button>
                        {!startingVoice && ' to talk.'}
                      </>
                    )}
                  </>
                ) : props.pageEditor ? (
                  'Describe the flow you want to build or change.'
                ) : (
                  'Ask anything…'
                )
              }
              onInterrupt={voice.status === 'speaking' || voice.status === 'processing' ? voice.interrupt : undefined}
            />
          </div>
          {activity.data && (activity.data.updates.length > 0 || activity.data.tasks.length > 0) && (
            <AssistantUpdateList
              updates={shownUpdates}
              tasks={activity.data.tasks}
              visible={props.visible}
              latestSequence={activity.data.conversation.latestUpdateSequence}
              hasMore={olderCursor === undefined ? activity.data.hasMore : olderCursor !== null}
              onLoadMore={async () => {
                if (oldestLoaded === null) return
                const page = await api.conversationActivity(props.id, oldestLoaded)
                setOlderUpdates((current) => [
                  ...page.updates.filter((update) => !current.some((row) => row.messageId === update.messageId)),
                  ...current,
                ])
                setOlderCursor(page.hasMore ? page.beforeSequence : null)
              }}
              onSeen={async (messageIds) => {
                await api.seen(props.id, messageIds)
                await refreshActivity()
              }}
              onSeenThrough={async (sequence) => {
                await api.seenThrough(props.id, sequence)
                await refreshActivity()
              }}
            />
          )}
          {mailboxError && (
            <p role="status" className="px-4 py-2 text-xs text-muted">
              Updates are temporarily unavailable. Retrying…
            </p>
          )}
          {(error || (voice.error && !voice.isReconnecting && voice.status !== 'connecting')) && (
            <div role="alert" className="max-h-28 shrink-0 overflow-y-auto break-words px-4 py-2 text-sm text-muted">
              {error
                ? summarizeAssistantError(error)
                : isRecoverableVoiceConnectionError(voice.error)
                  ? voice.pendingTextCount
                    ? 'Connection interrupted. Your message is queued.'
                    : 'Connection interrupted. Reconnect to continue.'
                  : summarizeAssistantError(voice.error ?? 'Connection failed')}
              <button
                className="tau-button ml-2 text-accent-light"
                onClick={() => {
                  if (error && pending) void send(pending.text)
                  else {
                    setError(undefined)
                    void voice.retryConnection()
                  }
                }}
              >
                {error ? 'Retry' : 'Reconnect'}
              </button>
            </div>
          )}
          <button
            hidden={!props.saveError}
            className="tau-button px-4 py-1 text-xs text-muted"
            onClick={() =>
              void props
                .append(latestHistory.current.filter((entry): entry is AssistantEntry => Boolean(entry.id)))
                .catch(() => {})
            }
          >
            Retry saving history
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void send(draft)
            }}
            className="flex shrink-0 gap-2 p-3 border-t border-th-border"
          >
            <textarea
              aria-label="Message Assistant"
              disabled={Boolean(props.pageEditor && !props.ready)}
              placeholder="Ask anything…"
              value={draft}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send(draft)
                }
              }}
              className="tau-field min-w-0 flex-1 resize-none rounded-xl px-3 py-2 text-base sm:text-sm"
            />
            <button
              disabled={
                Boolean(props.pageEditor && !props.ready) || busy || voice.pendingTextCount > 0 || !draft.trim()
              }
              className="tau-button tau-button-primary px-3 py-2 text-sm"
            >
              {busy ? (!useRealtime && !pendingVisible ? 'Working…' : 'Sending…') : 'Send'}
            </button>
          </form>
          {!useRealtime && <p className="px-4 pb-2 text-xs text-muted">User assistant · text only</p>}
        </>
      )}
    </div>
  )
}

/** Tracks document visibility so hidden tabs release the mailbox instead of consuming it silently. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}
