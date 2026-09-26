/**
 * One-release in-process fallback for the Tau → Ficus env rename (side-effect module).
 *
 * Imported FIRST by every Core entrypoint: later imports read `process.env` at
 * module load, so `TAU_*` must already be moved to `FICUS_*` by then. Its only
 * other import, the logger, reads no `TAU_*`/`FICUS_*` env. It logs names only,
 * never values. Wave 3 (Task 36) replaces the bridge with `stripLegacyEnv`.
 */
import { bridgeLegacyEnv } from '@ficus/shared/legacy-env'
import { createLogger } from '../lib/infra/logger'

const result = bridgeLegacyEnv(process.env)
const log = createLogger('legacy-env')

if (result.moved.length > 0) {
  log.warn(
    `legacy TAU_* environment moved to FICUS_*: ${result.moved.join(', ')} (rename them; TAU_* is ignored from the next release)`
  )
}
if (result.shadowed.length > 0) {
  log.debug(`legacy TAU_* variables ignored (FICUS_ already set): ${result.shadowed.length}`)
}
if (result.conflicts.length > 0) {
  log.error(
    `legacy TAU_* and FICUS_* disagree for: ${result.conflicts.join(', ')}; kept TAU_ for *ENCRYPTION_KEY*, FICUS_ otherwise — remove the wrong one`
  )
}
