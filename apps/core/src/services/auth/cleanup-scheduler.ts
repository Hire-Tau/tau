import { createLogger } from '../../lib/infra/logger'
import { cleanupExpiredAuthData } from './cleanup'

const log = createLogger('auth-cleanup-scheduler')

export const DEFAULT_AUTH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000

type IntervalHandle = ReturnType<typeof setInterval> | number
type SetIntervalFn = (callback: () => void, intervalMs: number) => IntervalHandle
type ClearIntervalFn = (handle: IntervalHandle) => void
type CleanupFn = (now: Date) => Promise<void>

export class AuthCleanupScheduler {
  private timer: IntervalHandle | null = null
  private running = false
  private readonly cleanup: CleanupFn
  private readonly now: () => Date
  private readonly intervalMs: number
  private readonly setIntervalFn: SetIntervalFn
  private readonly clearIntervalFn: ClearIntervalFn

  constructor(
    options: {
      cleanup?: CleanupFn
      now?: () => Date
      intervalMs?: number
      setIntervalFn?: SetIntervalFn
      clearIntervalFn?: ClearIntervalFn
    } = {}
  ) {
    this.cleanup = options.cleanup ?? cleanupExpiredAuthData
    this.now = options.now ?? (() => new Date())
    this.intervalMs = options.intervalMs ?? DEFAULT_AUTH_CLEANUP_INTERVAL_MS
    this.setIntervalFn = options.setIntervalFn ?? setInterval
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval
  }

  start(): void {
    this.stop()
    void this.tick()
    this.timer = this.setIntervalFn(() => void this.tick(), this.intervalMs)
    log.info(`Auth cleanup scheduled every ${Math.round(this.intervalMs / 60_000)} minute(s)`)
  }

  stop(): void {
    if (this.timer !== null) this.clearIntervalFn(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.cleanup(this.now())
    } catch (error) {
      log.error('Auth cleanup failed', error)
    } finally {
      this.running = false
    }
  }
}

let scheduler: AuthCleanupScheduler | null = null

export function startAuthCleanupScheduler(): AuthCleanupScheduler {
  scheduler ??= new AuthCleanupScheduler()
  scheduler.start()
  return scheduler
}

export function stopAuthCleanupScheduler(): void {
  scheduler?.stop()
  scheduler = null
}
