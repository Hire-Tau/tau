export const MIN_CHECK_INTERVAL_MS = 30_000
export const RESUME_WINDOW_MS = 3_000
export const PERIODIC_CHECK_INTERVAL_MS = 5 * 60 * 1000
export const SERVICE_WORKER_VERSION_TIMEOUT_MS = 3_000

export interface PwaUpdateController {
  /** Manually trigger a throttled check, optionally bypassing the throttle on resume. */
  checkForUpdate: (opts?: { isResume?: boolean }) => void
  /**
   * True while the app just came to the foreground and the user hasn't
   * interacted yet — the only time an update may be applied without asking.
   */
  isInAutoApplyWindow: () => boolean
  /** Tear down all listeners/timers. Idempotent. */
  dispose: () => void
}

interface InstallDeps {
  /** Re-reconcile update state against the registration (may auto-apply inside the resume window). */
  requestEvaluation: () => void
  now?: () => number
}

export function shouldCheckNow(args: { lastCheckAt: number | null; now: number; isResume: boolean }): boolean {
  const { lastCheckAt, now, isResume } = args
  if (isResume) return true
  if (lastCheckAt === null) return true
  return now - lastCheckAt >= MIN_CHECK_INTERVAL_MS
}

export function isWithinAutoApplyWindow(args: {
  visibilityState: DocumentVisibilityState
  now: number
  lastResumeAt: number
  lastInteractionAt: number
}): boolean {
  const { visibilityState, now, lastResumeAt, lastInteractionAt } = args
  if (visibilityState !== 'visible') return false
  if (now - lastResumeAt > RESUME_WINDOW_MS) return false
  if (lastInteractionAt > lastResumeAt) return false
  return true
}

export async function readServiceWorkerVersion(
  worker: ServiceWorker | null | undefined,
  timeoutMs = SERVICE_WORKER_VERSION_TIMEOUT_MS
): Promise<string | null> {
  if (!worker || typeof worker.postMessage !== 'function' || typeof MessageChannel === 'undefined') {
    return null
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let resolved = false
    const finish = (version: string | null) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeoutId)
      channel.port1.close?.()
      channel.port2.close?.()
      resolve(version)
    }
    const timeoutId = setTimeout(() => finish(null), timeoutMs)

    channel.port1.onmessage = (event) => {
      const version = event.data?.version
      finish(typeof version === 'string' && version.length > 0 ? version : null)
    }

    try {
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2])
    } catch {
      finish(null)
    }
  })
}

export function installPwaUpdateChecks(
  registration: ServiceWorkerRegistration,
  deps: InstallDeps
): PwaUpdateController {
  const now = deps.now ?? (() => Date.now())
  let lastCheckAt: number | null = null
  let lastResumeAt = now()
  let lastInteractionAt = 0
  let disposed = false

  const isInAutoApplyWindow = () =>
    !disposed &&
    isWithinAutoApplyWindow({
      visibilityState: document.visibilityState,
      now: now(),
      lastResumeAt,
      lastInteractionAt,
    })

  const checkForUpdate = (opts?: { isResume?: boolean }) => {
    if (disposed) return
    const isResume = opts?.isResume ?? false
    const currentTime = now()
    if (!shouldCheckNow({ lastCheckAt, now: currentTime, isResume })) {
      // Even when a network check is throttled, a waiting update may already exist.
      deps.requestEvaluation()
      return
    }

    lastCheckAt = currentTime
    Promise.resolve(registration.update())
      .catch(() => {
        // Failed update checks should not affect normal app usage.
      })
      .finally(() => deps.requestEvaluation())
    // Reconcile immediately in case a waiting update is already known.
    deps.requestEvaluation()
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      lastResumeAt = now()
      checkForUpdate({ isResume: true })
    }
  }
  const onFocus = () => checkForUpdate()
  const onOnline = () => checkForUpdate({ isResume: true })
  const onPageShow = () => {
    lastResumeAt = now()
    checkForUpdate({ isResume: true })
  }
  const onInteraction = () => {
    lastInteractionAt = now()
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  window.addEventListener('online', onOnline)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('pointerdown', onInteraction, { passive: true })
  window.addEventListener('keydown', onInteraction, { passive: true })

  const intervalId = setInterval(() => {
    if (document.visibilityState === 'visible') checkForUpdate()
  }, PERIODIC_CHECK_INTERVAL_MS)

  const dispose = () => {
    if (disposed) return
    disposed = true
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('pointerdown', onInteraction)
    window.removeEventListener('keydown', onInteraction)
    clearInterval(intervalId)
  }

  // The first pageshow/visibility event can fire before serviceWorker.ready resolves.
  // Check immediately after installing listeners so a cold visible PWA launch is covered.
  if (document.visibilityState === 'visible') {
    checkForUpdate({ isResume: true })
  }

  return { checkForUpdate, isInAutoApplyWindow, dispose }
}
