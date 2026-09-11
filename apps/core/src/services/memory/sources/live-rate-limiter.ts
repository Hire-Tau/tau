export class LiveRateLimitError extends Error {
  constructor(message = 'live memory source rate limit exceeded') {
    super(message)
    this.name = 'LiveRateLimitError'
  }
}

interface Bucket {
  tokens: number
  resetAt: number
}

/**
 * Small in-process fixed-window limiter for live adapter calls.
 * Keyed by caller/source so one noisy source cannot block indexed search.
 */
export class LiveRateLimiter {
  private buckets = new Map<string, Bucket>()

  constructor(private readonly now = () => Date.now()) {}

  take(key: string, perMinute: number): boolean {
    if (perMinute <= 0) return false
    const current = this.now()
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= current) {
      this.buckets.set(key, { tokens: perMinute - 1, resetAt: current + 60_000 })
      return true
    }
    if (bucket.tokens <= 0) return false
    bucket.tokens -= 1
    return true
  }

  reset(): void {
    this.buckets.clear()
  }
}

export const defaultLiveRateLimiter = new LiveRateLimiter()
