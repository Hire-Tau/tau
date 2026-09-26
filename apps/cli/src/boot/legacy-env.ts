/**
 * One-release in-process fallback for the Tau → Ficus env rename (side-effect module).
 *
 * Imported FIRST by the CLI entrypoint (and `scripts/pm2-name.ts`): later imports
 * read `process.env` at module load. Warns on stderr only when something moved,
 * so the normal case stays silent. Names only, never values. Wave 3 (Task 36)
 * replaces the bridge with `stripLegacyEnv`.
 */
import { bridgeLegacyEnv } from '@ficus/shared/legacy-env'

const result = bridgeLegacyEnv(process.env)

if (result.moved.length > 0) {
  process.stderr.write(
    `legacy TAU_* environment moved to FICUS_*: ${result.moved.join(', ')} (rename them; TAU_* is ignored from the next release)\n`
  )
}
if (result.conflicts.length > 0) {
  process.stderr.write(
    `legacy TAU_* and FICUS_* disagree for: ${result.conflicts.join(', ')}; kept TAU_ for *ENCRYPTION_KEY*, FICUS_ otherwise — remove the wrong one\n`
  )
}
