import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import type { ArtifactContext, ArtifactIndexItem } from '../api/artifacts'
import { queries } from '../queryOptions'
import { workspaceVoiceAssistant } from '../voice/assistants/workspace/workspaceAssistant'
import { buildWorkspaceDisplayInstructions } from '../voice/assistants/workspace/displayInstructions'
import { workspaceAssistantInstructions } from '../voice/assistants/workspace/workspaceInstructions'
import type { VoiceStatus, VoiceTranscriptEntry } from '../voice/types'
import { VoiceTranscriptInspector } from '../voice/VoiceTranscriptInspector'
import { useRealtimeVoiceAssistant, type VoiceInputMode } from '../voice/useRealtimeVoiceAssistant'
import { useStableRef } from '../hooks/useStableRef'
import { ArtifactRenderer } from './artifacts/ArtifactRenderer'
import {
  getStoredVoiceInputMode,
  handleManualHoldKeyDown,
  handleManualHoldKeyUp,
  handleManualVoiceOrbPointerDown,
  handleManualVoiceOrbPointerUp,
  setStoredVoiceInputMode,
} from './voiceWorkspaceInputMode'

export type VoiceWorkspaceEnvironment = {
  mediaDevices: Pick<MediaDevices, 'getUserMedia'> | undefined
  isSecureContext: boolean | undefined
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined
}

function browserVoiceWorkspaceEnvironment(): VoiceWorkspaceEnvironment {
  return {
    mediaDevices: typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
    isSecureContext: typeof window === 'undefined' ? undefined : window.isSecureContext,
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
  }
}

export function supportsRealtimeVoice(environment: VoiceWorkspaceEnvironment): boolean {
  if (!environment.mediaDevices?.getUserMedia) return false
  if (environment.isSecureContext === false) return false
  return true
}

type RealtimeVoiceHook = typeof useRealtimeVoiceAssistant

export function VoiceWorkspacePage({
  useRealtimeVoiceAssistant: useRealtimeVoiceAssistantProp = useRealtimeVoiceAssistant,
  environment = browserVoiceWorkspaceEnvironment(),
}: {
  useRealtimeVoiceAssistant?: RealtimeVoiceHook
  environment?: VoiceWorkspaceEnvironment
} = {}) {
  if (!supportsRealtimeVoice(environment)) {
    return (
      <main className="min-h-[100dvh] bg-white text-gray-950 flex items-center justify-center p-8">
        <p className="max-w-md text-center text-sm text-gray-500">
          Voice workspace requires microphone support in a secure browser context. Open Tau over HTTPS or localhost in a
          browser that supports WebRTC.
        </p>
      </main>
    )
  }

  return (
    <VoiceWorkspaceContent storage={environment.storage} useRealtimeVoiceAssistant={useRealtimeVoiceAssistantProp} />
  )
}

function VoiceWorkspaceContent({
  storage,
  useRealtimeVoiceAssistant,
}: {
  storage: VoiceWorkspaceEnvironment['storage']
  useRealtimeVoiceAssistant: RealtimeVoiceHook
}) {
  const [inputMode, setInputMode] = useState<VoiceInputMode>(() => getStoredVoiceInputMode(storage))
  const handleInputModeChange = (mode: VoiceInputMode) => {
    setInputMode(mode)
    setStoredVoiceInputMode(storage, mode)
  }

  return (
    <VoiceWorkspaceSession
      key={inputMode}
      inputMode={inputMode}
      onInputModeChange={handleInputModeChange}
      useRealtimeVoiceAssistant={useRealtimeVoiceAssistant}
    />
  )
}

function VoiceWorkspaceSession({
  inputMode,
  onInputModeChange,
  useRealtimeVoiceAssistant,
}: {
  inputMode: VoiceInputMode
  onInputModeChange: (mode: VoiceInputMode) => void
  useRealtimeVoiceAssistant: RealtimeVoiceHook
}) {
  const {
    status,
    error,
    state,
    isConnected,
    isMicMuted,
    inputLevel,
    history,
    updateInstructions,
    interrupt,
    startUserSpeech,
    submitUserSpeech,
    rateLimitRetry,
  } = useRealtimeVoiceAssistant(workspaceVoiceAssistant, {
    autoConnect: true,
    autoReconnect: true,
    inputMode,
  })
  const artifactsQuery = useQuery({
    ...queries.artifacts.list({ includeArchived: false }),
    refetchInterval: 5000,
  })
  const activeArtifact = getDisplayedArtifact(artifactsQuery.data, state.activeArtifactDisplay)
  const artifactContextQuery = useQuery({
    ...queries.artifacts.context(activeArtifact?.agentId ?? '', activeArtifact?.artifactId ?? ''),
    enabled: activeArtifact !== null,
    refetchInterval: activeArtifact !== null ? 5000 : false,
  })
  const [debugOpen, setDebugOpen] = useState(false)
  const currentDisplayInstructions = useMemo(
    () => buildWorkspaceDisplayInstructions(activeArtifact, artifactContextQuery.data),
    [activeArtifact, artifactContextQuery.data]
  )
  useEffect(() => {
    updateInstructions(`${workspaceAssistantInstructions}\n\n${currentDisplayInstructions}`)
  }, [currentDisplayInstructions, updateInstructions])
  const canInterrupt = status === 'speaking'
  const startManualSpeech = useCallback(() => {
    if (status === 'speaking') interrupt()
    startUserSpeech()
  }, [interrupt, startUserSpeech, status])

  useManualHoldToSpeakShortcut({
    enabled:
      inputMode === 'manual' &&
      isConnected &&
      rateLimitRetry === null &&
      (status === 'listening' || status === 'speaking' || status === 'user-speaking'),
    isHolding: status === 'user-speaking',
    onStart: startManualSpeech,
    onEnd: submitUserSpeech,
  })

  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-white text-gray-950">
      <ArtifactStage artifact={activeArtifact} context={artifactContextQuery.data} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(147,197,253,0.14),transparent_45%),radial-gradient(circle_at_50%_0%,rgba(221,214,254,0.16),transparent_35%)]" />
      <VoiceInputModeControl inputMode={inputMode} onInputModeChange={onInputModeChange} />
      <VoiceDebugInspector
        open={debugOpen}
        status={status}
        error={error}
        isConnected={isConnected}
        isMicMuted={isMicMuted}
        history={history}
        onToggle={() => setDebugOpen((value) => !value)}
      />
      <VoiceOrb
        status={status}
        error={error}
        isConnected={isConnected}
        canInterrupt={canInterrupt}
        isMicMuted={isMicMuted}
        retrySeconds={rateLimitRetry ? Math.ceil(rateLimitRetry.remainingMs / 1000) : null}
        inputLevel={inputLevel}
        inputMode={inputMode}
        onInterrupt={interrupt}
        onStartUserSpeech={startManualSpeech}
        onSubmitUserSpeech={submitUserSpeech}
      />
      {/* <div className="fixed bottom-2 left-1/2 z-20 -translate-x-1/2 rounded-full bg-white/75 px-3 py-1 text-center text-xs text-gray-500 shadow-sm backdrop-blur-md">
        {inputMode === 'manual'
          ? 'Hold the orb or space bar to speak. Release to submit.'
          : 'Listening...'}
      </div> */}
    </main>
  )
}

function VoiceInputModeControl({
  inputMode,
  onInputModeChange,
}: {
  inputMode: VoiceInputMode
  onInputModeChange: (mode: VoiceInputMode) => void
}) {
  return (
    <div
      role="group"
      aria-label="Voice input mode"
      className="fixed left-1/2 top-4 z-20 flex -translate-x-1/2 rounded-full border border-gray-200/70 bg-white/80 p-1 text-xs shadow-lg backdrop-blur-md"
    >
      {(['automatic', 'manual'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={inputMode === mode}
          onClick={(event) => {
            onInputModeChange(mode)
            event.currentTarget.blur()
          }}
          className={clsx(
            'tau-button',
            'rounded-full px-3 py-1.5 font-medium',
            inputMode === mode ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-white'
          )}
        >
          {mode === 'automatic' ? 'Automatic' : 'Hold to speak'}
        </button>
      ))}
    </div>
  )
}

function useManualHoldToSpeakShortcut({
  enabled,
  isHolding,
  onStart,
  onEnd,
}: {
  enabled: boolean
  isHolding: boolean
  onStart: () => void
  onEnd: () => void
}) {
  const onStartRef = useStableRef(onStart)
  const onEndRef = useStableRef(onEnd)
  const isHoldingRef = useStableRef(isHolding)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return

    const handleKeyDown = (event: KeyboardEvent) => {
      handleManualHoldKeyDown(event, isHoldingRef.current, onStartRef.current)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      handleManualHoldKeyUp(event, isHoldingRef.current, onEndRef.current)
    }
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; repeat?: boolean } | null
      if (data?.type === 'tau:voice-hold-keydown') {
        handleManualHoldKeyDown(
          { code: 'Space', repeat: data.repeat, target: null, preventDefault: () => undefined },
          isHoldingRef.current,
          onStartRef.current
        )
      }
      if (data?.type === 'tau:voice-hold-keyup') {
        handleManualHoldKeyUp(
          { code: 'Space', target: null, preventDefault: () => undefined },
          isHoldingRef.current,
          onEndRef.current
        )
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('keyup', handleKeyUp, { capture: true })
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('keyup', handleKeyUp, { capture: true })
      window.removeEventListener('message', handleMessage)
    }
  }, [enabled, isHoldingRef, onEndRef, onStartRef])
}

export function scrollVoiceDebugTranscriptToBottom(
  container: Pick<HTMLDivElement, 'scrollHeight' | 'scrollTop'>
): void {
  container.scrollTop = container.scrollHeight
}

export function scheduleVoiceDebugTranscriptScroll(container: HTMLDivElement): () => void {
  let cancelled = false
  let frame: number | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null

  const scroll = () => {
    if (cancelled) return
    scrollVoiceDebugTranscriptToBottom(container)
  }

  scroll()
  frame = requestAnimationFrame(scroll)
  timeout = setTimeout(scroll, 0)

  return () => {
    cancelled = true
    if (frame !== null) cancelAnimationFrame(frame)
    if (timeout !== null) clearTimeout(timeout)
  }
}

export function VoiceDebugInspector({
  open,
  status,
  error,
  isConnected,
  isMicMuted,
  history,
  onToggle,
}: {
  open: boolean
  status: VoiceStatus
  error: string | null
  isConnected: boolean
  isMicMuted: boolean
  history: VoiceTranscriptEntry[]
  onToggle: () => void
}) {
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = transcriptScrollRef.current
    if (!open || !container) return
    return scheduleVoiceDebugTranscriptScroll(container)
  }, [history, open])

  useEffect(() => {
    const container = transcriptScrollRef.current
    if (!open || !container) return

    const schedule = () => scheduleVoiceDebugTranscriptScroll(container)
    let cancelScheduledScroll = schedule()
    const reschedule = () => {
      cancelScheduledScroll()
      cancelScheduledScroll = schedule()
    }

    const mutationObserver = new MutationObserver(reschedule)
    mutationObserver.observe(container, { childList: true, subtree: true, characterData: true })

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reschedule)
    resizeObserver?.observe(container)
    if (container.firstElementChild) resizeObserver?.observe(container.firstElementChild)

    return () => {
      cancelScheduledScroll()
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
    }
  }, [open])

  return (
    <div className="fixed inset-x-3 top-3 z-30 flex max-w-[calc(100vw-1.5rem)] flex-wrap items-start justify-end gap-2 sm:inset-x-auto sm:right-4 sm:top-4 sm:max-w-none sm:flex-nowrap sm:gap-3">
      {open && (
        <aside className="max-h-[calc(100dvh-2rem)] w-full min-w-0 max-w-full overflow-hidden rounded-2xl border border-gray-200/70 bg-white/92 text-gray-950 shadow-2xl backdrop-blur-xl sm:w-[min(26rem,calc(100vw-2rem))]">
          <div className="flex items-center justify-between border-b border-gray-200/70 px-3 py-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Voice debug</div>
              <div className="mt-0.5 text-sm font-medium text-gray-900">Transcript & tool calls</div>
            </div>
            <button
              type="button"
              onClick={onToggle}
              className="tau-button rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            >
              Close
            </button>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-b border-gray-200/70 px-3 py-2 text-xs">
            <div>
              <dt className="text-gray-500">Status</dt>
              <dd className="font-medium text-gray-900">{status}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Connection</dt>
              <dd className="font-medium text-gray-900">{isConnected ? 'connected' : 'disconnected'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Mic</dt>
              <dd className="font-medium text-gray-900">{isMicMuted ? 'paused' : 'enabled'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Turns</dt>
              <dd className="font-medium text-gray-900">{history.length}</dd>
            </div>
            {error && (
              <div className="col-span-2">
                <dt className="text-gray-500">Error</dt>
                <dd className="font-medium text-red-600">{error}</dd>
              </div>
            )}
          </dl>
          <div ref={transcriptScrollRef} className="max-h-[min(34rem,calc(100dvh-11rem))] overflow-y-auto">
            <VoiceTranscriptInspector history={history} emptyLabel="No transcript yet." />
          </div>
        </aside>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={open}
        className="tau-button rounded-full border border-gray-200/70 bg-white/80 px-3 py-1.5 text-xs font-medium uppercase tracking-[0.16em] text-gray-600 shadow-lg backdrop-blur-md hover:bg-white hover:text-gray-950"
      >
        Debug
      </button>
    </div>
  )
}

function getDisplayedArtifact(
  artifacts: ArtifactIndexItem[] | undefined,
  display: { mode: 'latest' } | { mode: 'specific'; agentId: string; artifactId: string } | undefined
): ArtifactIndexItem | null {
  if (!artifacts || artifacts.length === 0) return null
  if (display?.mode === 'specific') {
    const selected = artifacts.find(
      (artifact) => artifact.agentId === display.agentId && artifact.artifactId === display.artifactId
    )
    if (selected) return selected
  }
  return artifacts.reduce(
    (latest, artifact) => (artifact.updatedAt > latest.updatedAt ? artifact : latest),
    artifacts[0]
  )
}

function ArtifactStage({ artifact, context }: { artifact: ArtifactIndexItem | null; context?: ArtifactContext }) {
  if (!artifact) return null

  const entry = context?.manifest.entry ?? artifact.entry
  if (!entry) return null

  const hasRenderableContent = context?.content !== undefined || entry.type === 'sandbox_app'
  if (!hasRenderableContent) return null

  return (
    <section className="relative z-0 h-[100dvh] w-full overflow-auto bg-white text-gray-950">
      <ArtifactRenderer
        entry={entry}
        content={context?.content}
        className={entry.type === 'presentation' ? undefined : 'h-[100dvh]'}
        presentationChrome="none"
      />
    </section>
  )
}

function VoiceOrb({
  status,
  error,
  isConnected,
  canInterrupt,
  isMicMuted,
  retrySeconds,
  inputLevel,
  inputMode,
  onInterrupt,
  onStartUserSpeech,
  onSubmitUserSpeech,
}: {
  status: VoiceStatus
  error: string | null
  isConnected: boolean
  canInterrupt: boolean
  isMicMuted: boolean
  retrySeconds: number | null
  inputLevel: number
  inputMode: VoiceInputMode
  onInterrupt: () => void
  onStartUserSpeech: () => void
  onSubmitUserSpeech: () => void
}) {
  const visualStatus = retrySeconds !== null ? 'rate-limited' : status
  const statusDescription =
    retrySeconds !== null
      ? `Rate limited for ${retrySeconds} seconds`
      : isMicMuted
        ? 'Microphone paused'
        : statusLabel(status)
  const canManualHold =
    inputMode === 'manual' && (status === 'listening' || status === 'speaking') && retrySeconds === null
  const canSubmitSpeech = status === 'user-speaking'
  const canManualInterruptHold = inputMode === 'manual' && canInterrupt
  const canClickOrb = canManualHold || canSubmitSpeech || canInterrupt
  const actionLabel =
    inputMode === 'manual' && (canManualHold || canSubmitSpeech)
      ? 'Hold to speak; release to submit'
      : canInterrupt
        ? 'Interrupt assistant'
        : canSubmitSpeech
          ? 'End and submit speech'
          : `Voice workspace status: ${statusLabel(status)}`

  return (
    <div className="fixed bottom-8 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
      <style>{ORB_STYLES}</style>
      <button
        type="button"
        disabled={!canClickOrb}
        onClick={
          canInterrupt && !canManualInterruptHold
            ? onInterrupt
            : inputMode === 'automatic' && canSubmitSpeech
              ? onSubmitUserSpeech
              : undefined
        }
        onPointerDown={(event) => {
          handleManualVoiceOrbPointerDown(event, canManualHold, onStartUserSpeech)
        }}
        onPointerUp={(event) => {
          handleManualVoiceOrbPointerUp(event, inputMode === 'manual' && canSubmitSpeech, onSubmitUserSpeech)
        }}
        onPointerCancel={() => {
          if (inputMode === 'manual' && canSubmitSpeech) onSubmitUserSpeech()
        }}
        aria-label={actionLabel}
        style={{ '--voice-input-level': Math.max(0, Math.min(inputLevel, 1)) } as CSSProperties}
        className={clsx(
          'tau-button',
          'voice-orb group relative h-24 w-24 rounded-full outline-none transition-transform duration-300 disabled:cursor-default disabled:opacity-100',
          canClickOrb && 'cursor-pointer focus-visible:ring-2 focus-visible:ring-rose-200/80',
          isConnected && 'voice-orb--live',
          canInterrupt && 'voice-orb--active',
          status === 'connecting' && 'voice-orb--connecting',
          status === 'listening' && !isMicMuted && 'voice-orb--listening',
          status === 'user-speaking' && 'voice-orb--user-speaking',
          status === 'listening' && isMicMuted && 'voice-orb--muted',
          status === 'speaking' && 'voice-orb--speaking',
          status === 'processing' && 'voice-orb--processing',
          retrySeconds !== null && 'voice-orb--warning',
          status === 'error' && 'voice-orb--error'
        )}
      >
        <span className="voice-orb__glow" />
        <span className="voice-orb__shell">
          <span className="voice-orb__swirl">
            <span className="voice-orb__blob voice-orb__blob--magenta" />
            <span className="voice-orb__blob voice-orb__blob--blue" />
            <span className="voice-orb__blob voice-orb__blob--violet" />
          </span>
          <span className="voice-orb__shade" />
          <span className="voice-orb__rim" />
          <span className="voice-orb__shine" />
        </span>
      </button>
      {error ? (
        <div className="max-w-[18rem] rounded-full border border-red-200/20 bg-black/35 px-3 py-1.5 text-center text-[10px] uppercase tracking-[0.22em] text-red-100/80 shadow-[0_12px_40px_rgba(0,0,0,0.18)] backdrop-blur-md">
          {error}
        </div>
      ) : (
        <div className="voice-orb-status" data-status={visualStatus} aria-label={statusDescription}>
          <span className="voice-orb-status__ring" />
          <span className="voice-orb-status__dot voice-orb-status__dot--one" />
          <span className="voice-orb-status__dot voice-orb-status__dot--two" />
          <span className="voice-orb-status__dot voice-orb-status__dot--three" />
        </div>
      )}
    </div>
  )
}

const ORB_STYLES = `
.voice-orb {
  transform: translateZ(0) scale(0.96);
}
.voice-orb--live {
  transform: translateZ(0) scale(1);
}
.voice-orb--active {
  transform: translateZ(0) scale(1.03);
}
.voice-orb--connecting {
  transform: translateZ(0) scale(1.08);
}
.voice-orb--listening {
  transform: translateZ(0) scale(1.02);
}
.voice-orb--user-speaking {
  transform: translateZ(0) scale(1.12);
}
.voice-orb--muted {
  transform: translateZ(0) scale(0.98);
}
.voice-orb--processing {
  transform: translateZ(0) scale(1.07);
}
.voice-orb--speaking {
  transform: translateZ(0) scale(1.1);
}
.voice-orb--warning,
.voice-orb--error {
  transform: translateZ(0) scale(1.06);
}
.voice-orb__glow {
  position: absolute;
  inset: 4%;
  border-radius: 9999px;
  background: radial-gradient(circle, rgba(168,85,247,0.34), rgba(59,130,246,0.24) 42%, rgba(236,72,153,0.16) 60%, transparent 78%);
  filter: blur(22px);
  opacity: 0.5;
  transition: opacity 240ms ease, transform 240ms ease;
}
.voice-orb--live .voice-orb__glow {
  opacity: 0.72;
  transform: scale(1.08);
}
.voice-orb--connecting .voice-orb__glow {
  opacity: 0.95;
  transform: scale(1.18);
  animation: voice-orb-connecting-glow 1.15s ease-in-out infinite;
}
.voice-orb--listening .voice-orb__glow {
  background: radial-gradient(circle, rgba(244,63,94,0.38), rgba(239,68,68,0.24) 42%, rgba(251,113,133,0.14) 62%, transparent 78%);
  opacity: 0.86;
  transform: scale(calc(1.08 + (var(--voice-input-level, 0) * 0.18)));
  animation: voice-orb-listening-glow 2.6s ease-in-out infinite;
}
.voice-orb--user-speaking .voice-orb__glow {
  background: radial-gradient(circle, rgba(244,63,94,0.58), rgba(220,38,38,0.36) 38%, rgba(251,113,133,0.22) 64%, transparent 82%);
  opacity: 1;
  transform: scale(calc(1.24 + (var(--voice-input-level, 0) * 0.28)));
  animation: voice-orb-user-speaking-glow 0.72s ease-in-out infinite;
}
.voice-orb--muted .voice-orb__glow {
  background: radial-gradient(circle, rgba(148,163,184,0.34), rgba(100,116,139,0.22) 46%, rgba(71,85,105,0.12) 66%, transparent 80%);
  opacity: 0.62;
  transform: scale(1.04);
  animation: voice-orb-muted-glow 4s ease-in-out infinite;
}
.voice-orb--processing .voice-orb__glow,
.voice-orb--speaking .voice-orb__glow {
  background: radial-gradient(circle, rgba(216,180,254,0.46), rgba(168,85,247,0.34) 38%, rgba(236,72,153,0.2) 62%, transparent 82%);
  opacity: 1;
  transform: scale(1.22);
  animation: voice-orb-speaking-glow 0.82s ease-in-out infinite;
}
.voice-orb--speaking .voice-orb__glow {
  transform: scale(1.3);
  animation-duration: 0.62s;
}
.voice-orb--warning .voice-orb__glow,
.voice-orb--error .voice-orb__glow {
  background: radial-gradient(circle, rgba(251,146,60,0.46), rgba(249,115,22,0.34) 40%, rgba(245,158,11,0.2) 64%, transparent 82%);
  opacity: 0.96;
  transform: scale(1.2);
  animation: voice-orb-warning-glow 1.25s ease-in-out infinite;
}
.voice-orb__shell {
  position: absolute;
  inset: 0;
  overflow: hidden;
  isolation: isolate;
  border: 1px solid rgba(255, 255, 255, 0.58);
  border-radius: 51% 49% 48% 52% / 49% 52% 48% 51%;
  transform-origin: 50% 52%;
  background:
    radial-gradient(circle at 31% 17%, rgba(255,255,255,0.96), rgba(240,249,255,0.34) 15%, transparent 31%),
    radial-gradient(circle at 66% 42%, rgba(255,255,255,0.18), transparent 18%),
    radial-gradient(circle at 50% 55%, rgba(255,255,255,0.28), rgba(219,234,254,0.12) 42%, rgba(15,23,42,0.05) 100%);
  box-shadow:
    inset 0 0 13px rgba(255,255,255,0.86),
    inset 12px 12px 24px rgba(255,255,255,0.22),
    inset -12px -18px 24px rgba(30,27,75,0.28),
    0 18px 44px rgba(67,56,202,0.16);
  animation: voice-orb-breathe 6.4s ease-in-out infinite;
}
.voice-orb__swirl {
  position: absolute;
  inset: 11%;
  border-radius: inherit;
  opacity: 0.95;
  filter: blur(8px) saturate(1.28) contrast(1.08);
  animation: voice-orb-swirl 11s linear infinite;
}
.voice-orb__blob {
  position: absolute;
  border-radius: 9999px;
  opacity: 0.86;
  mix-blend-mode: normal;
  transform-origin: 50% 50%;
}
.voice-orb__blob--magenta {
  left: 7%;
  bottom: 4%;
  width: 70%;
  height: 56%;
  background: radial-gradient(circle, rgba(236,72,153,0.86), rgba(168,85,247,0.44) 50%, transparent 76%);
  animation: voice-orb-blob-a 6.5s ease-in-out infinite;
}
.voice-orb__blob--blue {
  left: -4%;
  top: 20%;
  width: 72%;
  height: 62%;
  background: radial-gradient(circle, rgba(56,189,248,0.84), rgba(37,99,235,0.52) 48%, transparent 76%);
  animation: voice-orb-blob-b 7.6s ease-in-out infinite;
}
.voice-orb__blob--violet {
  right: -4%;
  top: -2%;
  width: 76%;
  height: 70%;
  background: radial-gradient(circle, rgba(192,132,252,0.84), rgba(109,40,217,0.56) 50%, transparent 78%);
  animation: voice-orb-blob-c 8.2s ease-in-out infinite;
}
.voice-orb__shade {
  position: absolute;
  inset: 0;
  z-index: 2;
  border-radius: inherit;
  background:
    radial-gradient(circle at 31% 18%, rgba(255,255,255,0.76), transparent 23%),
    radial-gradient(circle at 70% 44%, rgba(255,255,255,0.18), transparent 18%),
    radial-gradient(ellipse at 50% 88%, rgba(15,23,42,0.38), transparent 42%),
    radial-gradient(circle at 50% 50%, transparent 52%, rgba(255,255,255,0.3) 80%, rgba(49,46,129,0.16) 100%);
  pointer-events: none;
}
.voice-orb__rim {
  position: absolute;
  inset: 2%;
  z-index: 3;
  border-radius: inherit;
  border: 1px solid rgba(255,255,255,0.38);
  box-shadow: inset 3px 2px 8px rgba(255,255,255,0.46), inset -8px -8px 14px rgba(49,46,129,0.14);
}
.voice-orb__shine {
  position: absolute;
  left: 20%;
  top: 13%;
  z-index: 4;
  width: 48%;
  height: 16%;
  border-radius: 9999px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.72), transparent);
  filter: blur(5px);
  transform: rotate(-8deg);
  opacity: 0.68;
}
.voice-orb--connecting .voice-orb__shell {
  animation-duration: 2.2s;
  box-shadow:
    inset 0 0 16px rgba(255,255,255,0.96),
    inset 12px 12px 26px rgba(255,255,255,0.28),
    inset -12px -18px 26px rgba(30,27,75,0.32),
    0 18px 52px rgba(14,165,233,0.34),
    0 0 0 8px rgba(125,211,252,0.12);
}
.voice-orb--connecting .voice-orb__swirl {
  animation-duration: 3.2s;
}
.voice-orb--listening .voice-orb__shell {
  box-shadow:
    inset 0 0 14px rgba(255,255,255,0.9),
    inset 12px 12px 24px rgba(255,255,255,0.22),
    inset -12px -18px 24px rgba(127,29,29,0.2),
    0 18px 48px rgba(244,63,94,0.22),
    0 0 0 7px rgba(244,63,94,0.08);
}
.voice-orb--user-speaking .voice-orb__shell {
  animation-duration: 1.35s;
  box-shadow:
    inset 0 0 18px rgba(255,255,255,0.96),
    inset 12px 12px 28px rgba(255,255,255,0.28),
    inset -12px -18px 28px rgba(127,29,29,0.34),
    0 20px 62px rgba(244,63,94,0.38),
    0 0 0 10px rgba(244,63,94,0.12);
}
.voice-orb--listening .voice-orb__blob--magenta {
  background: radial-gradient(circle, rgba(244,63,94,0.88), rgba(236,72,153,0.48) 52%, transparent 76%);
}
.voice-orb--listening .voice-orb__swirl {
  animation-duration: 8.8s;
}
.voice-orb--user-speaking .voice-orb__swirl {
  animation-duration: 2.2s;
}
.voice-orb--user-speaking .voice-orb__blob--magenta {
  background: radial-gradient(circle, rgba(248,113,113,0.94), rgba(244,63,94,0.58) 52%, transparent 78%);
}
.voice-orb--muted .voice-orb__shell {
  animation-duration: 9s;
  box-shadow:
    inset 0 0 12px rgba(255,255,255,0.82),
    inset 12px 12px 22px rgba(255,255,255,0.16),
    inset -12px -18px 22px rgba(51,65,85,0.22),
    0 14px 36px rgba(71,85,105,0.16),
    0 0 0 6px rgba(148,163,184,0.08);
}
.voice-orb--muted .voice-orb__blob--magenta,
.voice-orb--muted .voice-orb__blob--blue,
.voice-orb--muted .voice-orb__blob--violet {
  background: radial-gradient(circle, rgba(148,163,184,0.72), rgba(71,85,105,0.34) 54%, transparent 78%);
  animation-duration: 10s;
}
.voice-orb--processing .voice-orb__shell,
.voice-orb--speaking .voice-orb__shell {
  animation-duration: 1.8s;
  box-shadow:
    inset 0 0 18px rgba(255,255,255,0.98),
    inset 12px 12px 28px rgba(255,255,255,0.3),
    inset -12px -18px 28px rgba(88,28,135,0.34),
    0 18px 58px rgba(168,85,247,0.36),
    0 0 0 9px rgba(216,180,254,0.12);
}
.voice-orb--processing .voice-orb__swirl,
.voice-orb--speaking .voice-orb__swirl {
  animation-duration: 2.6s;
}
.voice-orb--processing .voice-orb__blob--magenta,
.voice-orb--processing .voice-orb__blob--blue,
.voice-orb--processing .voice-orb__blob--violet,
.voice-orb--speaking .voice-orb__blob--magenta,
.voice-orb--speaking .voice-orb__blob--blue,
.voice-orb--speaking .voice-orb__blob--violet {
  animation-duration: 3.2s;
}
.voice-orb--speaking .voice-orb__shell {
  animation-name: voice-orb-breathe-speaking;
  animation-duration: 1.05s;
}
.voice-orb--speaking .voice-orb__swirl {
  animation-duration: 1.9s;
}
.voice-orb--speaking .voice-orb__blob--magenta,
.voice-orb--speaking .voice-orb__blob--blue,
.voice-orb--speaking .voice-orb__blob--violet {
  animation-duration: 2.35s;
}
.voice-orb--warning .voice-orb__shell,
.voice-orb--error .voice-orb__shell {
  animation-duration: 2.4s;
  box-shadow:
    inset 0 0 16px rgba(255,255,255,0.94),
    inset 12px 12px 26px rgba(255,255,255,0.24),
    inset -12px -18px 26px rgba(124,45,18,0.28),
    0 18px 54px rgba(249,115,22,0.32),
    0 0 0 8px rgba(251,146,60,0.12);
}
.voice-orb--warning .voice-orb__blob--magenta,
.voice-orb--error .voice-orb__blob--magenta {
  background: radial-gradient(circle, rgba(251,146,60,0.88), rgba(244,63,94,0.42) 52%, transparent 76%);
}
.voice-orb--warning .voice-orb__blob--violet,
.voice-orb--error .voice-orb__blob--violet {
  background: radial-gradient(circle, rgba(253,186,116,0.82), rgba(249,115,22,0.5) 52%, transparent 78%);
}
.voice-orb-status {
  position: relative;
  display: none;
  grid-template-columns: repeat(3, 4px);
  gap: 6px;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 20px;
  opacity: 0.96;
}
.voice-orb-status__ring {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 10px;
  height: 10px;
  border: 1px solid rgba(224, 242, 254, 0.82);
  border-radius: 9999px;
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.8);
}
.voice-orb-status__dot {
  width: 4px;
  height: 4px;
  border-radius: 9999px;
  background: rgba(240, 249, 255, 0.95);
  box-shadow: 0 0 10px rgba(255,255,255,0.7), 0 0 18px rgba(147, 197, 253, 0.65);
  transform: scale(0.72);
}
.voice-orb-status[data-status='idle'] .voice-orb-status__dot {
  animation: voice-status-idle 2.8s ease-in-out infinite;
}
.voice-orb-status__dot--two {
  animation-delay: 120ms !important;
}
.voice-orb-status__dot--three {
  animation-delay: 240ms !important;
}
@keyframes voice-orb-connecting-glow {
  0%, 100% { filter: blur(22px); opacity: 0.66; transform: scale(1.08); }
  50% { filter: blur(30px); opacity: 1; transform: scale(1.24); }
}
@keyframes voice-orb-listening-glow {
  0%, 100% { filter: blur(22px); opacity: 0.62; transform: scale(1.06); }
  50% { filter: blur(28px); opacity: 0.92; transform: scale(1.18); }
}
@keyframes voice-orb-user-speaking-glow {
  0%, 100% { filter: blur(22px); opacity: 0.82; transform: scale(1.2); }
  50% { filter: blur(34px); opacity: 1; transform: scale(1.42); }
}
@keyframes voice-orb-muted-glow {
  0%, 100% { filter: blur(18px); opacity: 0.38; transform: scale(0.98); }
  50% { filter: blur(24px); opacity: 0.68; transform: scale(1.08); }
}
@keyframes voice-orb-speaking-glow {
  0%, 100% { filter: blur(24px); opacity: 0.72; transform: scale(1.1); }
  50% { filter: blur(34px); opacity: 1; transform: scale(1.3); }
}
@keyframes voice-orb-warning-glow {
  0%, 100% { filter: blur(23px); opacity: 0.62; transform: scale(1.08); }
  50% { filter: blur(32px); opacity: 0.98; transform: scale(1.24); }
}
@keyframes voice-status-idle {
  0%, 100% { opacity: 0.38; transform: scale(0.68); }
  50% { opacity: 0.82; transform: scale(0.92); }
}
@keyframes voice-status-wave {
  0%, 100% { opacity: 0.42; transform: translateY(2px) scale(0.72); }
  50% { opacity: 0.95; transform: translateY(-3px) scale(1.08); }
}
@keyframes voice-status-listen {
  0%, 100% { opacity: 0.56; transform: scale(0.78); }
  50% { opacity: 1; transform: scale(1.08); }
}
@keyframes voice-status-speaking {
  0%, 100% { opacity: 0.5; transform: translateY(3px) scaleY(0.75); }
  50% { opacity: 1; transform: translateY(-4px) scaleY(1.55); }
}
@keyframes voice-status-rate {
  0%, 100% { opacity: 0.4; transform: scale(0.68); }
  50% { opacity: 1; transform: scale(1.02); }
}
@keyframes voice-status-ping {
  0% { opacity: 0.55; transform: translate(-50%, -50%) scale(0.65); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(2.8); }
}
@keyframes voice-orb-breathe {
  0%, 100% {
    border-radius: 51% 49% 48% 52% / 49% 52% 48% 51%;
    transform: scale(1) rotate(0deg);
  }
  28% {
    border-radius: 48% 52% 51% 49% / 52% 48% 51% 49%;
    transform: scale(1.018) rotate(0.8deg);
  }
  58% {
    border-radius: 53% 47% 49% 51% / 47% 51% 49% 53%;
    transform: scale(1.026) rotate(-0.7deg);
  }
  78% {
    border-radius: 49% 51% 53% 47% / 51% 49% 52% 48%;
    transform: scale(1.012) rotate(0.35deg);
  }
}
@keyframes voice-orb-breathe-speaking {
  0%, 100% {
    border-radius: 51% 49% 48% 52% / 49% 52% 48% 51%;
    transform: scale(0.99) rotate(0deg);
  }
  34% {
    border-radius: 47% 53% 52% 48% / 53% 47% 52% 48%;
    transform: scale(1.07) rotate(1deg);
  }
  66% {
    border-radius: 54% 46% 48% 52% / 46% 52% 48% 54%;
    transform: scale(1.12) rotate(-0.9deg);
  }
}
@keyframes voice-orb-swirl {
  from { transform: rotate(0deg) scale(1.04); }
  to { transform: rotate(360deg) scale(1.04); }
}
@keyframes voice-orb-blob-a {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(10%, 12%) scale(1.14); }
}
@keyframes voice-orb-blob-b {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(-12%, -8%) scale(1.12); }
}
@keyframes voice-orb-blob-c {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(4%, -16%) scale(1.2); }
}
`

function statusLabel(status: VoiceStatus): string {
  switch (status) {
    case 'idle':
      return 'Starting voice workspace'
    case 'connecting':
      return 'Connecting'
    case 'listening':
      return 'Listening'
    case 'user-speaking':
      return 'Listening to you'
    case 'processing':
      return 'Thinking'
    case 'speaking':
      return 'Speaking'
    case 'error':
      return 'Error'
  }
}
