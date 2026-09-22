/** Per-query-client/execution budget. Views share reads, including the causal
 * history watermark, but retain their own identity/subscription fences. */
export class SilentConversationRecovery<T> {
  private attempts = 0
  private activity = -Infinity
  private lastAttempt = -Infinity
  private pending: Promise<T | undefined> | undefined
  private result: T | undefined
  private controller: AbortController | undefined

  dispose() {
    this.controller?.abort()
  }

  peek() {
    return this.result
  }

  hasRecentRead(now: number) {
    return !!this.pending || now - this.lastAttempt < 4000
  }

  delay(now: number, lastActivity: number): number | undefined {
    this.activity = Math.max(this.activity, lastActivity)
    if (this.attempts >= 3) return undefined
    return Math.max(0, this.activity + 15_000 - now, this.lastAttempt + [0, 30_000, 60_000][this.attempts]! - now)
  }

  read(now: number, manual: boolean, read: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (this.pending) return this.pending
    // Coalesce simultaneous observers and foreground/manual overlap. Explicit intent
    // does not replenish the automatic budget.
    if (now - this.lastAttempt < 4000) return Promise.resolve(this.result)
    if (!manual && this.attempts >= 3) return Promise.resolve(undefined)
    this.lastAttempt = now
    if (!manual) this.attempts++
    this.result = undefined
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const canceled = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(undefined), { once: true })
    })
    this.pending = Promise.race([read(controller.signal), canceled])
      .then(
        (result) => {
          this.result = result
          return result
        },
        () => undefined
      )
      .finally(() => {
        clearTimeout(timeout)
        this.pending = undefined
        this.controller = undefined
      })
    return this.pending
  }
}

const scopes = new WeakMap<object, Map<string, { recovery: SilentConversationRecovery<unknown>; users: number }>>()
export function acquireSilentRecovery<T>(client: object, key: string) {
  let entries = scopes.get(client)
  if (!entries) {
    entries = new Map()
    scopes.set(client, entries)
  }
  let entry = entries.get(key)
  if (!entry) {
    entry = { recovery: new SilentConversationRecovery(), users: 0 }
    entries.set(key, entry)
  }
  entry.users++
  return {
    recovery: entry.recovery as SilentConversationRecovery<T>,
    release: () => {
      if (--entry.users === 0) {
        entry.recovery.dispose()
        entries!.delete(key)
      }
    },
  }
}

// FocusManager synchronously notifies all mounted observers. Each owns its SSE
// replacement, but only one should cancel/refetch their shared query collection.
// Do not use this for terminal confirmation: a post-confirmation read may need to
// supersede a pre-confirmation request even within the same task.
const foregroundRefreshes = new WeakMap<object, Set<string>>()
export function coalesceForegroundRefresh(client: object, agentId: string, refresh: () => void) {
  let agents = foregroundRefreshes.get(client)
  if (!agents) {
    agents = new Set()
    foregroundRefreshes.set(client, agents)
  }
  if (agents.has(agentId)) return
  agents.add(agentId)
  queueMicrotask(() => agents.delete(agentId))
  refresh()
}
