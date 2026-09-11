import { sourceCapabilities } from '../adapter'
import type { LiveMemorySourceAdapter, LiveSearchResult, LiveSearchScope } from '../live-adapter'

export interface FakeLiveSourceOptions {
  sourceType?: string
  timeoutMs?: number
  perMinute?: number
  results?: LiveSearchResult[]
  delayMs?: number
  fail?: Error
}

export class FakeLiveSource implements LiveMemorySourceAdapter {
  readonly sourceType: string
  readonly capabilities = sourceCapabilities(['live', 'searchable'])
  readonly defaultSensitivity = 'internal' as const
  readonly timeoutMs: number
  readonly rateLimit: { perMinute: number }
  calls: Array<{ query: string; opts: LiveSearchScope }> = []

  constructor(private readonly options: FakeLiveSourceOptions = {}) {
    this.sourceType = options.sourceType ?? 'fake_live'
    this.timeoutMs = options.timeoutMs ?? 250
    this.rateLimit = { perMinute: options.perMinute ?? 60 }
  }

  async search(query: string, opts: LiveSearchScope): Promise<LiveSearchResult[]> {
    this.calls.push({ query, opts })
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs))
    if (this.options.fail) throw this.options.fail
    return this.options.results ?? []
  }
}
