/**
 * One-release in-process fallback for the Tau → Ficus env rename (side-effect module).
 *
 * Imported FIRST by the sandbox executor (`server.ts`): later imports read
 * `process.env` at module load. Names only, never values. Wave 3 (Task 36)
 * replaces the bridge with `stripLegacyEnv`.
 */
import { bridgeLegacyEnv } from '@ficus/shared/legacy-env'

const result = bridgeLegacyEnv(process.env)

if (result.moved.length > 0) {
  console.warn(
    `[sandbox] legacy TAU_* environment moved to FICUS_*: ${result.moved.join(', ')} (rename them; TAU_* is ignored from the next release)`
  )
}
if (result.conflicts.length > 0) {
  console.error(
    `[sandbox] legacy TAU_* and FICUS_* disagree for: ${result.conflicts.join(', ')}; kept TAU_ for *ENCRYPTION_KEY*, FICUS_ otherwise — remove the wrong one`
  )
}
