import { createLogger } from '../../lib/infra/logger'
import { getLimit, type ConcurrencyLimits } from './concurrency-config'

const log = createLogger('concurrency-limits')

export type { ConcurrencyLimits }

export interface ConcurrencyKey {
  provider: string
  modelId?: string
}

interface ExecutionSlot extends ConcurrencyKey {
  limitKey?: string
}

export function parseConcurrencyKey(value: string): ConcurrencyKey {
  const slash = value.indexOf('/')
  if (slash > 0) {
    return {
      provider: value.slice(0, slash).trim(),
      modelId: value.slice(slash + 1).trim() || undefined,
    }
  }
  return { provider: value.trim(), modelId: undefined }
}

function keyOf(provider: string, modelId?: string): string {
  return modelId ? `${provider}/${modelId}` : provider
}

/**
 * Per-worker in-memory provider concurrency limiter. Tracks active in-flight
 * executions per configured limit key plus the provider/model each execution
 * currently uses (so runtime failover can move the accounting). Unlimited
 * providers are tracked in executionSlots but not counted. Not cluster-aware —
 * matches the per-worker model of MAX_CONCURRENT_AGENTS / session-state.ts.
 */
export class ConcurrencyLimiter {
  private inFlight = new Map<string, number>()
  private executionSlots = new Map<string, ExecutionSlot>()

  constructor(private readonly limits: ConcurrencyLimits) {}

  getLimit(provider: string, modelId?: string): number | undefined {
    return getLimit(this.limits, provider, modelId)
  }

  hasCapacity(provider: string, modelId?: string): boolean {
    const limitKey = this.resolveLimitKey(provider, modelId)
    if (!limitKey) return true
    return (this.inFlight.get(limitKey) ?? 0) < this.limits[limitKey]
  }

  getInFlight(provider: string, modelId?: string): number {
    const limitKey = this.resolveLimitKey(provider, modelId)
    if (!limitKey) return 0
    return this.inFlight.get(limitKey) ?? 0
  }

  /** Whether executionId currently holds a tracked slot (of any provider). */
  hasSlot(executionId: string): boolean {
    return this.executionSlots.has(executionId)
  }

  /**
   * Claim a slot. Returns false (untracked) if at capacity. Always tracks
   * otherwise (even for unlimited providers) so failover has a slot to move.
   */
  tryAcquire(executionId: string, provider: string, modelId?: string): boolean {
    const existing = this.executionSlots.get(executionId)
    if (existing) {
      if (existing.provider === provider && existing.modelId === modelId) return true
      this.release(executionId)
    }

    const limitKey = this.resolveLimitKey(provider, modelId)
    if (limitKey) {
      const limit = this.limits[limitKey]
      const current = this.inFlight.get(limitKey) ?? 0
      if (current >= limit) {
        log.warn(`Holding execution ${executionId}: provider ${limitKey} at capacity (${current}/${limit})`)
        return false
      }
      this.inFlight.set(limitKey, current + 1)
    }

    this.executionSlots.set(executionId, { provider, modelId, limitKey })
    return true
  }

  /** Release the slot for executionId. Idempotent. */
  release(executionId: string): void {
    const slot = this.executionSlots.get(executionId)
    if (!slot) return
    this.executionSlots.delete(executionId)

    if (!slot.limitKey) return
    this.decrement(slot.limitKey)
  }

  /**
   * Move an execution's slot to a new provider/modelId. No-op if unchanged.
   * Force-increments past the limit (the execution is already running).
   */
  reassign(executionId: string, provider: string, modelId?: string): void {
    const old = this.executionSlots.get(executionId)
    const newLimitKey = this.resolveLimitKey(provider, modelId)

    if (old?.provider === provider && old.modelId === modelId && old.limitKey === newLimitKey) return

    if (old?.limitKey && old.limitKey !== newLimitKey) {
      this.decrement(old.limitKey)
    }

    if (newLimitKey && old?.limitKey !== newLimitKey) {
      const next = (this.inFlight.get(newLimitKey) ?? 0) + 1
      const limit = this.limits[newLimitKey]
      this.inFlight.set(newLimitKey, next)
      if (next > limit) {
        log.info(`Execution ${executionId} failed over to ${newLimitKey} now over capacity (${next}/${limit})`)
      }
    }

    this.executionSlots.set(executionId, { provider, modelId, limitKey: newLimitKey })
  }

  reset(): void {
    this.inFlight.clear()
    this.executionSlots.clear()
  }

  snapshot(): Record<string, { inFlight: number; limit: number }> {
    const out: Record<string, { inFlight: number; limit: number }> = {}
    for (const [key, limit] of Object.entries(this.limits)) {
      out[key] = { inFlight: this.inFlight.get(key) ?? 0, limit }
    }
    return out
  }

  private resolveLimitKey(provider: string, modelId?: string): string | undefined {
    if (provider && modelId) {
      const modelKey = keyOf(provider, modelId)
      if (this.limits[modelKey] != null) return modelKey
    }
    if (provider && this.limits[provider] != null) return provider
    return undefined
  }

  private decrement(limitKey: string): void {
    const next = Math.max(0, (this.inFlight.get(limitKey) ?? 0) - 1)
    if (next === 0) this.inFlight.delete(limitKey)
    else this.inFlight.set(limitKey, next)
  }
}
