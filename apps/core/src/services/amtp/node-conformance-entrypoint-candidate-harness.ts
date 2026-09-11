import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

interface CandidateResult {
  kind: 'amtp-node-candidate-result'
  entrypoint: string
  beforeDigest: string
  afterDigest: string
  markers: string[]
}

const EXPECTED_MARKERS = ['action-settled', 'import-settled']
const HASH_PATTERN = /^[a-f0-9]{64}$/

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`candidate-harness:${name.toLowerCase()}-missing`)
  return value
}

function resolveCandidateEntrypoint(candidateRoot: string): string {
  const root = realpathSync(resolve(candidateRoot))
  const entrypoint = realpathSync(join(root, 'src', 'index.ts'))
  const entryRelativeToRoot = relative(root, entrypoint)
  if (entryRelativeToRoot.startsWith(`..${sep}`) || entryRelativeToRoot === '..') {
    throw new Error('candidate-harness:path-escaped-root')
  }
  if (entryRelativeToRoot !== join('src', 'index.ts')) {
    throw new Error(`candidate-harness:unexpected-path:${entryRelativeToRoot}`)
  }
  return entrypoint
}

function parseCandidateResult(stdout: string): CandidateResult {
  const terminalLine = stdout.trim().split('\n').at(-1)
  if (!terminalLine) throw new Error('candidate-harness:missing-child-result')
  const parsed = JSON.parse(terminalLine) as Partial<CandidateResult>
  if (
    parsed.kind !== 'amtp-node-candidate-result' ||
    typeof parsed.entrypoint !== 'string' ||
    typeof parsed.beforeDigest !== 'string' ||
    typeof parsed.afterDigest !== 'string' ||
    !Array.isArray(parsed.markers) ||
    !parsed.markers.every((marker) => typeof marker === 'string')
  ) {
    throw new Error('candidate-harness:invalid-child-result')
  }
  return parsed as CandidateResult
}

const candidateRoot = requiredEnvironment('AMTP_NODE_CANDIDATE_ROOT')
const expectedDigest = requiredEnvironment('AMTP_NODE_CANDIDATE_SHA256')
if (!HASH_PATTERN.test(expectedDigest)) throw new Error('candidate-harness:invalid-sha256')

const entrypoint = resolveCandidateEntrypoint(candidateRoot)
const beforeDigest = sha256(entrypoint)
if (beforeDigest !== expectedDigest) {
  throw new Error(`candidate-harness:pre-child-digest-mismatch:${beforeDigest}`)
}

const scratchDirectory = mkdtempSync(join(tmpdir(), 'amtp-node-candidate-harness-'))
const markerPath = join(scratchDirectory, 'markers.log')
const childPath = join(import.meta.dir, 'node-conformance-entrypoint-candidate-child.ts')
try {
  const child = Bun.spawn([process.execPath, childPath], {
    cwd: candidateRoot,
    env: {
      ...process.env,
      AMTP_NODE_CANDIDATE_ROOT: candidateRoot,
      AMTP_NODE_CANDIDATE_SHA256: expectedDigest,
      AMTP_NODE_CANDIDATE_MARKER_PATH: markerPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`candidate-harness:child-failed:${exitCode}:${stderr.trim()}`)
  }

  const result = parseCandidateResult(stdout)
  const afterDigest = sha256(entrypoint)
  if (
    afterDigest !== expectedDigest ||
    result.beforeDigest !== expectedDigest ||
    result.afterDigest !== expectedDigest
  ) {
    throw new Error(
      `candidate-harness:digest-changed:expected=${expectedDigest}:child-before=${result.beforeDigest}:child-after=${result.afterDigest}:parent-after=${afterDigest}`
    )
  }
  if (result.entrypoint !== entrypoint) {
    throw new Error(`candidate-harness:child-entrypoint-mismatch:${result.entrypoint}`)
  }
  if (JSON.stringify(result.markers) !== JSON.stringify(EXPECTED_MARKERS)) {
    throw new Error(`candidate-harness:lifecycle-order:${result.markers.join('->')}`)
  }

  console.log(
    JSON.stringify({
      kind: 'amtp-node-candidate-harness-pass',
      entrypoint,
      digest: expectedDigest,
      markers: result.markers,
      childPid: child.pid,
    })
  )
} finally {
  rmSync(scratchDirectory, { recursive: true, force: true })
}
