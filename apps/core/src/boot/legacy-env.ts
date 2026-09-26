/**
 * One-release in-process fallback for the Tau → Ficus env rename (side-effect module).
 *
 * Imported FIRST by every Core entrypoint: later imports read `process.env` at
 * module load, so `TAU_*` must already be moved to `FICUS_*` by then. Its only
 * other import, the logger, reads no `TAU_*`/`FICUS_*` env. It logs names only,
 * never values. Wave 3 (Task 36) replaces the bridge with `stripLegacyEnv`.
 */
import { bridgeLegacyEnv, formatLegacyEnvBridge } from '@ficus/shared/legacy-env'
import { createLogger } from '../lib/infra/logger'

const lines = formatLegacyEnvBridge(bridgeLegacyEnv(process.env))
const log = createLogger('legacy-env')

if (lines.warn) log.warn(lines.warn)
if (lines.debug) log.debug(lines.debug)
if (lines.error) log.error(lines.error)
