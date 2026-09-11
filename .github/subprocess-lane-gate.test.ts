import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Keeps the `subprocess-tests` lane's membership honest.
 *
 * ci.yml's `test` job runs the whole Core sweep as a single `bun test` over
 * ~762 files on one shared runner, after a monorepo typecheck, a CLI build,
 * the web gate, the mobile suite and the platform suite. A separate
 * `subprocess-tests` job with its own runner and Postgres already exists for
 * the expensive class — tests that spawn a real `bun` subprocess — but its
 * membership was a hand-maintained list. Every NEW such test silently
 * defaulted into the contended job.
 *
 * That drift is the structural defect, not the placement of any one file
 * (docs/history/design/ci-stability-and-flake-eradication.md, B2). This gate is the
 * fix: adding a real-bun-spawning test to apps/core without adding it to the
 * lane fails here, with a message saying exactly what to do.
 *
 * When it first ran, eleven files had already drifted — including three that
 * appear in the failure catalogue by name (`store-hermetic`, `kubeconfig`,
 * `node-conformance-registration`) and one, `cli-help.test.ts`, running a full
 * `bun run build:cli` inside the shared job.
 *
 * Scope: `apps/core` only, which is where the lane lives.
 */

const REPO_ROOT = join(import.meta.dir, '..')
const CORE_SRC = join(REPO_ROOT, 'apps/core/src')
const WORKFLOW = join(REPO_ROOT, '.github/workflows/ci.yml')

/**
 * True when `source` spawns a real `bun` subprocess.
 *
 * Deliberately conservative: it looks for a spawn call whose command mentions
 * `process.execPath`, a literal `bun`, or a conventionally-named executable
 * variable, within a window after the call. A command assembled from an opaque
 * variable can evade it — this catches the shapes the repo actually uses, and
 * a miss means a file is not FORCED into the lane, never that a listed file is
 * silently dropped.
 */
export function spawnsRealBun(source: string): boolean {
  // Capturing a process through the shared ownership helpers is still a real
  // spawn. Otherwise improving diagnostics silently removes lane detection.
  if (/\b(?:spawnFileCapturedChild|runFileCapturedProcess|runCapturedProcess)\s*\(/.test(source)) return true
  const spawnCall = /Bun\.spawn(?:Sync)?\(/g
  for (let match = spawnCall.exec(source); match !== null; match = spawnCall.exec(source)) {
    const window = source.slice(match.index, match.index + 300)
    if (/process\.execPath|executablePath|bunExecutable|bunBin|['"]bun['"]/.test(window)) return true
  }
  return false
}

function testFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...testFilesUnder(full))
    } else if (entry.endsWith('.test.ts')) {
      found.push(full)
    }
  }
  return found
}

/** The `src/…` paths listed in the lane's `bun test` invocation. */
function laneMembers(): string[] {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const step = workflow.indexOf('Run real-subprocess tests')
  expect(step).toBeGreaterThan(-1)
  // The step's `run:` block ends at the next key at its indentation.
  const block = workflow.slice(step, workflow.indexOf('\n        env:', step))
  return [...block.matchAll(/(src\/[\w./-]+\.test\.ts)/g)].map((m) => m[1]!)
}

describe('subprocess-tests lane membership', () => {
  test('every apps/core test that spawns a real bun subprocess is in the lane', () => {
    const lane = new Set(laneMembers())
    const drifted = testFilesUnder(CORE_SRC)
      .filter((file) => spawnsRealBun(readFileSync(file, 'utf8')))
      .map((file) => `src/${file.slice(CORE_SRC.length + 1)}`)
      .filter((rel) => !lane.has(rel))
      .sort()

    expect(
      drifted,
      drifted.length === 0
        ? ''
        : `These apps/core tests spawn a real bun subprocess but run in the contended \`test\` job:\n` +
            drifted.map((f) => `  ${f}`).join('\n') +
            `\n\nAdd each to the "Run real-subprocess tests" step in .github/workflows/ci.yml. ` +
            `If one genuinely belongs in the shared job, say why in this gate rather than deleting the assertion.`
    ).toEqual([])
  })

  test('every file listed in the lane still exists', () => {
    // A rename that misses the workflow leaves `bun test` naming a path that no
    // longer exists — which Bun does not treat as an error, so the test simply
    // stops running and the lane stays green.
    const missing = laneMembers().filter((rel) => {
      try {
        return !statSync(join(REPO_ROOT, 'apps/core', rel)).isFile()
      } catch {
        return true
      }
    })
    expect(missing).toEqual([])
  })

  test('the lane is not empty and names the job it belongs to', () => {
    // Guards the parser itself: a workflow edit that breaks the extraction
    // would otherwise make both assertions above pass vacuously against [].
    const workflow = readFileSync(WORKFLOW, 'utf8')
    expect(workflow).toContain('subprocess-tests:')
    expect(laneMembers().length).toBeGreaterThanOrEqual(6)
  })
})

describe('spawnsRealBun', () => {
  test('detects the spawn shapes this repo uses', () => {
    for (const helper of ['spawnFileCapturedChild', 'runFileCapturedProcess', 'runCapturedProcess'])
      expect(spawnsRealBun(`${helper}(command, options)`)).toBe(true)
    expect(spawnsRealBun(`Bun.spawn([process.execPath, join(dir, 'index.ts')])`)).toBe(true)
    expect(spawnsRealBun(`Bun.spawnSync(['bun', 'run', 'build:cli'], { cwd: ROOT })`)).toBe(true)
    expect(spawnsRealBun(`Bun.spawnSync(\n  [executablePath, './fixture.ts'],\n  { cwd: repoRoot }\n)`)).toBe(true)
  })

  test('does not flag cheap shell spawns or non-spawning files', () => {
    // These stay in the shared job on purpose — the lane is for real bun
    // subprocesses, not for every child process.
    expect(spawnsRealBun(`Bun.spawnSync(['bash', '-c', 'echo hi'])`)).toBe(false)
    expect(spawnsRealBun(`Bun.spawn(['pkill', '-TERM', 'x'])`)).toBe(false)
    expect(spawnsRealBun(`const x = 'bun is mentioned in a comment'`)).toBe(false)
  })
})
