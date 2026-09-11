/**
 * Event-driven onboarding-status invalidation.
 *
 * The checklist status is always DERIVED fresh on read (status.ts's
 * getOnboardingStatus / getLiveSignals) — nothing here computes or caches
 * state. This module's only job is to tell subscribed clients "recompute
 * now" the moment a REAL signal changes, so the checklist/banner updates
 * instantly instead of waiting for useOnboarding.ts's fallback poll.
 *
 * `notifyOnboardingChanged()` is the single emit primitive: every signal
 * source below calls it. `registerOnboardingEventSources()` wires the
 * sources that aren't already covered by a direct call at their mutation's
 * chokepoint (account-store.ts, routes/users.ts, routes/remote-hosts.ts,
 * routes/onboarding.ts call `notifyOnboardingChanged()` themselves).
 */
import { eventEmitter } from '../../lib/infra/event-emitter'
import { getSettingsStore } from '../settings'
import { getSecretStore } from '../secrets'

/**
 * An OAuth round-trip or a provider add fires several account-store writes
 * in quick succession; collapse a burst into a single trailing emit.
 * Invalidation is idempotent, so debouncing costs nothing but redundant
 * client refetches.
 */
const ONBOARDING_EVENT_DEBOUNCE_MS = 1000

/**
 * Leading-edge debounce, implemented locally rather than via the shared
 * DebouncedQueue primitive (which only supports TRAILING debounce — every
 * call resets the timer, so a sustained burst can starve the signal
 * indefinitely; measured 0 emits across 600ms of 25Hz calls). Changing
 * DebouncedQueue's semantics would affect its other callers, so this module
 * implements its own window instead:
 *
 * - The first call in a quiet period emits immediately — the operator's own
 *   action (e.g. adding a provider key) is never delayed.
 * - Further calls within `delayMs` of the leading emit are suppressed, not
 *   dropped: if any arrived, exactly one trailing emit fires when the window
 *   closes, so a change during the quiet period is never lost.
 * - A call after the window has closed opens a fresh window (immediate emit
 *   again).
 */
let windowOpen = false
let windowTimer: NodeJS.Timeout | null = null
let suppressedCallPending = false

/**
 * Emit a leading-edge-debounced `onboarding.updated` event — a pure
 * "recompute now" signal with no payload. Call this from every real
 * onboarding-signal mutation.
 *
 * `delayMs` is exposed only so tests don't have to wait out the real
 * production suppression window; every production call site omits it.
 */
export function notifyOnboardingChanged(delayMs: number = ONBOARDING_EVENT_DEBOUNCE_MS): void {
  if (windowOpen) {
    suppressedCallPending = true
    return
  }

  windowOpen = true
  suppressedCallPending = false
  eventEmitter.emit('onboarding.updated', {})

  windowTimer = setTimeout(() => {
    windowOpen = false
    windowTimer = null
    if (suppressedCallPending) {
      suppressedCallPending = false
      eventEmitter.emit('onboarding.updated', {})
    }
  }, delayMs)
}

/** GitHub/Slack/Discord items derive from these — see status.ts's hasChatChannelTokenSet. */
const ONBOARDING_SECRET_KEYS: ReadonlySet<string> = new Set([
  'SLACK_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
])

let registered = false
let unsubscribers: Array<() => void> = []

/**
 * Wire every onboarding signal source that isn't already covered by a direct
 * `notifyOnboardingChanged()` call at its mutation's chokepoint:
 *  - secret-store changes to SLACK_BOT_TOKEN/DISCORD_BOT_TOKEN
 *    (the github/chat_channel items).
 *  - squad.created/squad.archived (the first_squad item).
 *
 * Must be called once in EACH process (api and worker) — every process holds
 * its own SecretStore instance/cache, so each needs its own onChange
 * listener; the distributed eventEmitter then carries the resulting
 * `onboarding.updated` to the api's WS bridge regardless of which process
 * emitted it. Idempotent: a second call in the same process is a no-op.
 *
 * Captures every listener's unsubscribe function so
 * `resetOnboardingEventSourcesForTest` can actually detach them — otherwise a
 * test's reset()+register() cycle leaves the previous cycle's listeners
 * attached and each real signal double-fires.
 */
export function registerOnboardingEventSources(): void {
  if (registered) return
  registered = true

  const unsubscribeSecretStore = getSecretStore().onChange((key) => {
    if (ONBOARDING_SECRET_KEYS.has(key) || key.startsWith('__integration-')) notifyOnboardingChanged()
  })
  const unsubscribeSquadCreated = eventEmitter.on('squad.created', () => notifyOnboardingChanged())
  const unsubscribeSquadArchived = eventEmitter.on('squad.archived', () => notifyOnboardingChanged())

  const unsubscribeSettings = getSettingsStore().onChange((key) => {
    if (key.startsWith('__integration-enabled:')) notifyOnboardingChanged()
  })
  unsubscribers = [unsubscribeSecretStore, unsubscribeSettings, unsubscribeSquadCreated, unsubscribeSquadArchived]
}

/** Reset registration state (for testing only). */
export function resetOnboardingEventSourcesForTest(): void {
  registered = false
  for (const unsubscribe of unsubscribers) unsubscribe()
  unsubscribers = []

  if (windowTimer) {
    clearTimeout(windowTimer)
    windowTimer = null
  }
  windowOpen = false
  suppressedCallPending = false
}
