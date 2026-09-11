import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A skipped check is not a green one.
 *
 * `core-typecheck-diagnostics` is gated to `workflow_dispatch`, so on every
 * pull_request run GitHub reports it with conclusion "skipped" — and a skipped
 * check renders alongside the passing ones. That colour is not execution
 * evidence, and a canceled run has already produced a misleading green partial
 * check-run (docs/history/design/ci-stability-and-flake-eradication.md, D2).
 *
 * The presentation itself is GitHub's and cannot be asserted from here. What
 * CAN be pinned is that the job stays manual, that it says so where a reader
 * looks, and that a run which produces no measurements FAILS rather than
 * completing green with an empty artifact. Those are the properties that make
 * "it ran" distinguishable from "it was skipped".
 */

interface Job {
  name?: string
  if?: string
  steps?: { name?: string; run?: string; with?: Record<string, unknown>; 'continue-on-error'?: boolean }[]
  'continue-on-error'?: boolean
}

const WORKFLOW = join(import.meta.dir, 'workflows/ci.yml')
const source = readFileSync(WORKFLOW, 'utf8')

async function diagnosticsJob(): Promise<Job> {
  const yaml = (await import('yaml')) as { parse: (s: string) => { jobs?: Record<string, Job> } }
  const job = yaml.parse(source).jobs?.['core-typecheck-diagnostics']
  expect(job, 'core-typecheck-diagnostics job is missing from ci.yml').toBeDefined()
  return job!
}

describe('core-typecheck-diagnostics is manual, and says so', () => {
  test('stays workflow_dispatch-only — it is far too expensive for PR CI', async () => {
    const job = await diagnosticsJob()
    expect(job.if).toBe("github.event_name == 'workflow_dispatch'")
  })

  test('its displayed name says a skipped run is not evidence', async () => {
    // This is the string a reviewer sees next to the skipped check, so it is
    // the one place the distinction cannot be missed.
    const job = await diagnosticsJob()
    expect(job.name ?? '').toMatch(/manual only/i)
    expect(job.name ?? '').toMatch(/not evidence/i)
  })

  test('a run producing no measurements fails instead of uploading nothing', async () => {
    // Without this, a job that executed but measured nothing uploads an empty
    // artifact and completes green — a green that is not evidence.
    const job = await diagnosticsJob()
    const upload = job.steps?.find((s) => s.name === 'Upload Core typecheck diagnostics')
    expect(upload?.with?.['if-no-files-found']).toBe('error')
  })

  test('nothing in the job swallows a failure', async () => {
    const job = await diagnosticsJob()
    expect(job['continue-on-error'] ?? false).toBe(false)
    for (const step of job.steps ?? []) {
      expect(step['continue-on-error'] ?? false).toBe(false)
    }
  })

  test('an executed run leaves a summary naming the exact SHA', async () => {
    // The summary exists only when the job actually ran, so its presence is the
    // execution evidence the check colour cannot supply.
    const job = await diagnosticsJob()
    const summary = job.steps?.find((s) => s.name === 'Record what this run measured')
    expect(summary, 'the execution-evidence summary step is missing').toBeDefined()
    expect(summary!.run ?? '').toContain('GITHUB_STEP_SUMMARY')
    expect(summary!.run ?? '').toContain('GITHUB_SHA')
  })

  test('the expensive comparison is not wired into normal PR CI', async () => {
    // Guards against the job being "helpfully" un-gated later: no other job may
    // invoke the diagnostics script.
    const callers = source.split('\n').filter((line) => line.includes('core-typecheck-diagnostics.sh'))
    expect(callers.length).toBeGreaterThan(0)
    for (const line of callers) {
      expect(line).toMatch(/RUNNER_TEMP|runner\.temp/)
    }
    const job = await diagnosticsJob()
    expect(job.steps?.some((s) => (s.run ?? '').includes('core-typecheck-diagnostics.sh'))).toBe(true)
  })
})
