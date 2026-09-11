import { createLogger } from '../../lib/infra/logger'
import { materializeSquadRemoteHosts } from './materialize'
import { listSquadIdsWithGrants } from './queries'

const log = createLogger('remote-hosts-backfill')

/**
 * Boot-time re-materialization of every non-archived granted squad's SSH
 * config. Closes the gap for squads granted before the host runtime
 * rendered absolute paths (issue #1331): their managed block still names
 * `~/.ssh/...`, which on host expands to the operator's home. Idempotent
 * (`materializeSquadRemoteHosts` is) and failure-isolated per squad: one
 * bad squad logs a warning and never blocks the rest or boot. Returns the
 * number of squads successfully materialized.
 */
export async function backfillSquadSshConfigs(): Promise<number> {
  const squadIds = await listSquadIdsWithGrants()
  let ok = 0
  for (const squadId of squadIds) {
    try {
      await materializeSquadRemoteHosts(squadId)
      ok++
    } catch (err) {
      log.warn(`SSH config backfill failed for squad ${squadId}:`, err)
    }
  }
  return ok
}
