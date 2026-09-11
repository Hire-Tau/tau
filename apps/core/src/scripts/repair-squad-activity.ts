import { ACTIVITY_REPAIR_LEASE_TASK, runLeasedActivityRepair } from '../services/squad-activity/maintenance'
import { getPoolMax } from '../db/connection'

const MAX_REPAIR_WINDOW_MS = 30 * 86_400_000
const USAGE = 'Usage: bun activity:repair --from <ISO UTC> --to <ISO UTC> [--wait <minutes>] [--concurrency <1-16>]'
const WAIT_RETRY_MS = 30_000

export interface ActivityRepairCliArgs {
  from: Date
  to: Date
  /** Keep retrying a held lease for this long before giving up. */
  waitMs?: number
  concurrency?: number
}

export function parseActivityRepairArgs(args: readonly string[]): ActivityRepairCliArgs {
  const values = new Map<string, string>()
  const known = new Set(['--from', '--to', '--wait', '--concurrency'])
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag || !known.has(flag) || !value || value.startsWith('--') || values.has(flag)) throw new TypeError(USAGE)
    values.set(flag, value)
  }
  if (!values.has('--from') || !values.has('--to')) throw new TypeError(USAGE)
  const parse = (flag: '--from' | '--to') => {
    const raw = values.get(flag)!
    const date = new Date(raw)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw) || date.toISOString() !== raw)
      throw new TypeError(`${USAGE}\n${flag} must be a canonical UTC ISO timestamp`)
    return date
  }
  const from = parse('--from')
  const to = parse('--to')
  if (from >= to) throw new TypeError(`${USAGE}\n--from must be before --to`)
  if (to.getTime() - from.getTime() > MAX_REPAIR_WINDOW_MS)
    throw new TypeError(`${USAGE}\nrepair window must not exceed 30 days`)
  const parsePositiveInt = (flag: '--wait' | '--concurrency', max: number) => {
    const raw = values.get(flag)
    if (raw === undefined) return undefined
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max || String(parsed) !== raw)
      throw new TypeError(
        `${USAGE}\n${flag} must be an integer between 1 and ${max}` +
          (flag === '--concurrency' ? ' (poolMax-2; raise DATABASE_POOL_MAX to allow more)' : '')
      )
    return parsed
  }
  const waitMinutes = parsePositiveInt('--wait', 24 * 60)
  // Concurrency above poolMax-2 starves this process's own pool: probes and
  // page loads queue behind materialize transactions, which is the exact
  // saturation profile that trips the liveness watchdog into a pool swap.
  // Raise DATABASE_POOL_MAX for the process to unlock higher concurrency.
  const concurrencyCap = Math.max(1, Math.min(16, getPoolMax() - 2))
  const concurrency = parsePositiveInt('--concurrency', concurrencyCap)
  return {
    from,
    to,
    ...(waitMinutes === undefined ? {} : { waitMs: waitMinutes * 60_000 }),
    ...(concurrency === undefined ? {} : { concurrency }),
  }
}

export async function runActivityRepairCli(
  args: readonly string[],
  runRepair = runLeasedActivityRepair,
  waitRetryMs = WAIT_RETRY_MS
): Promise<number> {
  let parsed: ActivityRepairCliArgs
  try {
    parsed = parseActivityRepairArgs(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const controller = new AbortController()
  const abort = (signal: 'SIGINT' | 'SIGTERM') => controller.abort(new Error(`Activity repair received ${signal}`))
  const onInt = () => abort('SIGINT')
  const onTerm = () => abort('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  try {
    console.error(JSON.stringify({ event: 'activity_repair_started', ...parsed }))
    const { waitMs, ...repairArgs } = parsed
    const deadline = Date.now() + (waitMs ?? 0)
    let report = null
    for (;;) {
      report = await runRepair({
        ...repairArgs,
        task: ACTIVITY_REPAIR_LEASE_TASK,
        signal: controller.signal,
      })
      if (report || Date.now() + waitRetryMs > deadline || controller.signal.aborted) break
      console.error(JSON.stringify({ event: 'activity_repair_lease_held', retryInMs: waitRetryMs }))
      // Abort-aware sleep: Ctrl-C during the wait must not linger to the next
      // retry (which would acquire and release a lease just to bail).
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitRetryMs)
        function done() {
          controller.signal.removeEventListener('abort', done)
          clearTimeout(timer)
          resolve()
        }
        controller.signal.addEventListener('abort', done, { once: true })
      })
      if (controller.signal.aborted) break
    }
    if (!report && controller.signal.aborted) throw controller.signal.reason ?? new Error('Activity repair aborted')
    if (!report)
      throw new Error(
        'Another Activity repair holds the maintenance lease (the worker runs a periodic repair; ' +
          'a held lease expires within 15 minutes). Re-run shortly or pass --wait <minutes> to keep retrying.'
      )
    console.log(JSON.stringify({ from: parsed.from.toISOString(), to: parsed.to.toISOString(), ...report }))
    if (report.errors > 0) {
      console.error(
        JSON.stringify({
          event: 'activity_repair_partial_failure',
          errors: report.errors,
          families: Object.fromEntries(
            Object.entries(report.families)
              .filter(([, family]) => family.errors > 0)
              .map(([family, detail]) => [family, { errors: detail.errors, failures: detail.failures }])
          ),
        })
      )
      return 1
    }
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}

if (import.meta.main) {
  const code = await runActivityRepairCli(process.argv.slice(2))
  // The imported db pool keeps Bun's event loop alive after the run — without
  // an explicit exit the process lingers forever (observed as a zombie repair
  // on a live tenant). Everything is flushed/released by now; exit hard.
  process.exit(code)
}
