import type { TerminationIntentReason } from './types'

export class TerminationIntentRegistry {
  private readonly intents = new Map<string, { reason: TerminationIntentReason; at: number }>()

  constructor(private readonly ttlMs = 120_000) {}

  record(sandboxId: string, reason: TerminationIntentReason): void {
    this.intents.set(sandboxId, { reason, at: Date.now() })
  }

  private fresh(sandboxId: string, now: number): { reason: TerminationIntentReason; at: number } | null {
    const entry = this.intents.get(sandboxId)
    if (!entry) return null
    if (now - entry.at > this.ttlMs) {
      this.intents.delete(sandboxId)
      return null
    }
    return entry
  }

  has(sandboxId: string, now = Date.now()): boolean {
    return this.fresh(sandboxId, now) !== null
  }

  consume(sandboxId: string, now = Date.now()): TerminationIntentReason | null {
    const entry = this.fresh(sandboxId, now)
    if (!entry) return null
    this.intents.delete(sandboxId)
    return entry.reason
  }
}

export const terminationIntentRegistry = new TerminationIntentRegistry()
