import { createLogger } from '../../lib/infra/logger'
import { getSettingsStore } from '../settings'
import { detectDeploymentFlavor, supportsAutoUpdate } from './deployment-flavor'
import type { DeploymentFlavor } from './deployment-flavor'
import { UpdateLockedError, localUpdateManager } from './local-updater'
import { DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS } from './types'

const log = createLogger('local-update-scheduler')
const MIN_INTERVAL_MS = 60_000

type Store = {
  getTyped(key: string): unknown
  onChange(listener: (key: string, value: string) => void | Promise<void>): void
}
type Updater = { apply(opts: { manual: boolean; settings?: { githubConnectionId?: string } }): Promise<unknown> }
type IntervalHandle = ReturnType<typeof setInterval>
type SetIntervalFn = (callback: () => void, intervalMs: number) => IntervalHandle
type ClearIntervalFn = (handle: IntervalHandle) => void

export class LocalUpdateScheduler {
  private timer: IntervalHandle | null = null
  private running = false
  private store: Store
  private updater: Updater
  private flavor: () => DeploymentFlavor
  private setIntervalFn: SetIntervalFn
  private clearIntervalFn: ClearIntervalFn

  constructor(
    options: {
      store?: Store
      updater?: Updater
      flavor?: () => DeploymentFlavor
      setIntervalFn?: SetIntervalFn
      clearIntervalFn?: ClearIntervalFn
    } = {}
  ) {
    this.store = options.store ?? getSettingsStore()
    this.updater = options.updater ?? localUpdateManager
    this.flavor = options.flavor ?? (() => detectDeploymentFlavor())
    this.setIntervalFn = options.setIntervalFn ?? setInterval
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval
  }

  start(): void {
    this.reschedule()
    this.store.onChange((key) => {
      if (key === 'LOCAL_AUTO_UPDATE_ENABLED' || key === 'LOCAL_AUTO_UPDATE_INTERVAL_MINUTES') this.reschedule()
    })
  }

  stop(): void {
    if (this.timer) this.clearIntervalFn(this.timer)
    this.timer = null
  }

  private reschedule(): void {
    this.stop()
    if (this.store.getTyped('LOCAL_AUTO_UPDATE_ENABLED') !== true) return
    const intervalMinutes = Number(
      this.store.getTyped('LOCAL_AUTO_UPDATE_INTERVAL_MINUTES') ?? DEFAULT_LOCAL_AUTO_UPDATE_SETTINGS.intervalMinutes
    )
    const intervalMs = Math.max(MIN_INTERVAL_MS, intervalMinutes * 60_000)
    this.timer = this.setIntervalFn(() => void this.tick(), intervalMs)
    void this.tick()
    log.info(`Local auto updater scheduled every ${Math.round(intervalMs / 60_000)} minute(s)`)
  }

  private async tick(): Promise<void> {
    if (this.running) return
    const support = supportsAutoUpdate(this.flavor())
    if (!support.ok) {
      log.info(`Skipping local auto update: ${support.reason ?? 'unsupported deployment flavor'}`)
      return
    }
    this.running = true
    try {
      const connectionId = this.store.getTyped('LOCAL_AUTO_UPDATE_GITHUB_CONNECTION_ID')
      await this.updater.apply({
        manual: false,
        ...(typeof connectionId === 'string' && connectionId ? { settings: { githubConnectionId: connectionId } } : {}),
      })
    } catch (error) {
      // Both core processes (api + worker) run a scheduler; losing the
      // cross-process run lock to the other one is expected, not a failure.
      if (error instanceof UpdateLockedError) {
        log.info('Skipping local auto update: an update is already running in another process')
      } else {
        log.error('Local auto update failed', error)
      }
    } finally {
      this.running = false
    }
  }
}

let scheduler: LocalUpdateScheduler | null = null
export function startLocalUpdateScheduler(): LocalUpdateScheduler {
  scheduler ??= new LocalUpdateScheduler()
  scheduler.start()
  return scheduler
}
export function stopLocalUpdateScheduler(): void {
  scheduler?.stop()
  scheduler = null
}
