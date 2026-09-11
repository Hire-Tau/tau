import { readFileSync } from 'fs'
import { join } from 'path'

// Loaded only by .github/bunfig.toml. Validate the intended serial setting too,
// so the probe distinguishes real config discovery from a coincidentally green
// hermetic suite and fails if the filename or concurrency contract is mutated.
const config = readFileSync(join(import.meta.dir, 'bunfig.toml'), 'utf8')
if (!/^maxConcurrency\s*=\s*1\s*$/m.test(config)) {
  throw new Error('exe lifecycle CI requires maxConcurrency = 1')
}
;(globalThis as typeof globalThis & { __exeLifecycleCiConfig?: string }).__exeLifecycleCiConfig =
  'preload:maxConcurrency=1'
