import { backfillExecutionUsage } from '../services/execution/usage-backfill'

const USAGE =
  'Usage: bun usage:backfill [--squad <uuid>] [--agent <uuid>]... [--apply]\n' +
  '  Reconstructs per-execution usage deltas from the stored cumulative snapshots.\n' +
  '  Without --apply this is a dry run and only reports what it would write.'

export interface UsageBackfillCliArgs {
  squadId?: string
  agentIds: string[]
  apply: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseUsageBackfillArgs(args: readonly string[]): UsageBackfillCliArgs {
  let squadId: string | undefined
  const agentIds: string[] = []
  let apply = false

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--apply') {
      apply = true
      continue
    }
    const value = args[index + 1]
    if ((flag !== '--squad' && flag !== '--agent') || !value || !UUID.test(value)) throw new TypeError(USAGE)
    if (flag === '--squad') {
      if (squadId) throw new TypeError(`${USAGE}\n--squad may only be given once`)
      squadId = value
    } else {
      agentIds.push(value)
    }
    index += 1
  }

  if (squadId && agentIds.length > 0) throw new TypeError(`${USAGE}\n--squad and --agent are mutually exclusive`)
  return { ...(squadId ? { squadId } : {}), agentIds, apply }
}

export async function runUsageBackfillCli(
  args: readonly string[],
  run = backfillExecutionUsage,
  write: (line: string) => void = console.log
): Promise<number> {
  let parsed: UsageBackfillCliArgs
  try {
    parsed = parseUsageBackfillArgs(args)
  } catch (error) {
    write(error instanceof Error ? error.message : String(error))
    return 1
  }

  const summary = await run({
    ...(parsed.squadId ? { squadId: parsed.squadId } : {}),
    ...(parsed.agentIds.length ? { agentIds: parsed.agentIds } : {}),
    apply: parsed.apply,
  })

  write(
    `${parsed.apply ? 'Backfilled' : 'Would backfill'} ${summary.executionsUpdated} execution(s) ` +
      `across ${summary.agentsScanned} agent(s) (${summary.executionsScanned} scanned).`
  )
  if (!parsed.apply && summary.executionsUpdated > 0) write('Re-run with --apply to write.')
  return 0
}

if (import.meta.main) {
  runUsageBackfillCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
