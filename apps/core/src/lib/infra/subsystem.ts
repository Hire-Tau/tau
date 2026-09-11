/**
 * Minimal structural logger accepted by {@link startSubsystems} and
 * {@link stopSubsystems} — matches the shape of {@link ScopedLogger} from
 * `./logger` (and thus works with `createLogger(...)` directly) without
 * forcing callers to import that type.
 */
export interface Logger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/**
 * One ordered start/stop unit for an entrypoint's boot list.
 *
 * Entrypoints (worker.ts, index.ts) each declare ONE explicit ordered
 * `Subsystem[]` — start iterates it forward, shutdown iterates it in
 * reverse — so a started subsystem structurally cannot lack a stop.
 */
export interface Subsystem {
  name: string
  start(): void | Promise<void>
  /** Must be safe to call when start failed part-way; never throws out. */
  stop(): void | Promise<void>
}

/** Build a {@link Subsystem} from its parts. */
export function subsystem(name: string, start: Subsystem['start'], stop: Subsystem['stop']): Subsystem {
  return { name, start, stop }
}

/**
 * Start every subsystem in `list`, in order, awaiting each before starting
 * the next. If a subsystem's start() throws, log it, stop the already-started
 * prefix (the subsystems before the failing one) in reverse order, then
 * rethrow — boot must fail loudly rather than limp along half-started.
 */
export async function startSubsystems(list: Subsystem[], log: Logger): Promise<void> {
  const started: Subsystem[] = []

  for (const item of list) {
    try {
      await item.start()
      started.push(item)
      log.info(`Started subsystem: ${item.name}`)
    } catch (err) {
      log.error(`Failed to start subsystem ${item.name}:`, err)
      // stopSubsystems reverses internally, so pass `started` in its
      // original (start) order.
      await stopSubsystems(started, log)
      throw err
    }
  }
}

/**
 * Stop every subsystem in `list`, in REVERSE order. Each stop() is isolated
 * in its own try/catch and logged on failure — one failing stop never skips
 * the rest, and this function itself never throws.
 */
export async function stopSubsystems(list: Subsystem[], log: Logger): Promise<void> {
  for (const item of [...list].reverse()) {
    try {
      await item.stop()
      log.info(`Stopped subsystem: ${item.name}`)
    } catch (err) {
      log.error(`Failed to stop subsystem ${item.name}:`, err)
    }
  }
}
