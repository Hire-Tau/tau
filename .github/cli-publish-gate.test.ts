import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// CLI releases must publish the complete archive and installer set without
// depending on SSH access to a deployment host.

interface Step {
  name?: string
  if?: string
  uses?: string
  env?: Record<string, unknown>
  run?: string
  with?: Record<string, unknown>
}

interface Workflow {
  jobs?: Record<string, { steps?: Step[] }>
}

const workflowPath = join(import.meta.dir, 'workflows/cli-binaries.yml')
const workflow = Bun.YAML.parse(readFileSync(workflowPath, 'utf8')) as Workflow
const steps = workflow.jobs?.['publish-cli-release']?.steps ?? []

function indexOfStep(name: string): number {
  const index = steps.findIndex((candidate) => candidate.name === name)
  if (index === -1) throw new Error(`cli-binaries.yml: no step named ${JSON.stringify(name)} — did it get renamed?`)
  return index
}

const releaseStepIndexes = steps
  .map((step, index) => ({ step, index }))
  .filter(({ step }) => String(step.uses ?? '').startsWith('softprops/action-gh-release'))

describe('CLI publish gate', () => {
  test('all five binaries are built in the release job without Actions artifact storage', () => {
    const serialized = JSON.stringify(workflow)
    expect(serialized).not.toContain('actions/upload-artifact')
    expect(serialized).not.toContain('actions/download-artifact')
    const collect = indexOfStep('Collect release assets')
    for (const target of [
      'bun-darwin-arm64',
      'bun-darwin-x64',
      'bun-linux-arm64',
      'bun-linux-x64',
      'bun-windows-x64',
    ]) {
      const compile = steps.findIndex((step) => step.run?.includes(`--target=${target}`))
      expect(compile).toBeGreaterThan(-1)
      expect(compile).toBeLessThan(collect)
    }
    expect(steps[indexOfStep('Collect release assets')].run).toContain('find dist/packages')
  })

  // `tau skill install <name>` resolves from the archive's skills/ directory,
  // so every bundled skill under external/skills must be copied — a per-skill
  // `cp` silently ships an archive on which `tau skill install tau` fails.
  test('every compile step bundles the whole external/skills directory', () => {
    const compileSteps = steps.filter((step) => step.run?.includes('--compile'))
    expect(compileSteps.length).toBe(5)
    for (const step of compileSteps) {
      expect({ name: step.name, bundlesAllSkills: step.run?.includes('cp -R external/skills/. ') }).toEqual({
        name: step.name,
        bundlesAllSkills: true,
      })
      expect(step.run).not.toContain('external/skills/tau-memory')
    }
  })

  test('the publish job actually has steps (the parser did not silently find nothing)', () => {
    expect(steps.length).toBeGreaterThan(0)
  })

  // Deliberately serialized rather than `step.run`-only: a marketplace action
  // (burnett01/rsync-deployments and friends) reaches the host through `uses`
  // + `with`, never touching `run`, and a run-only scan waves it straight
  // through.
  test('no step reaches for rsync, ssh or scp — in a run block or a marketplace action', () => {
    const offenders = steps
      .filter((step) => /rsync|\bssh\b|\bscp\b/.test(JSON.stringify(step)))
      .map((step) => step.name ?? step.uses ?? '<unnamed>')
    expect(offenders).toEqual([])
  })

  // The sharper check, and the one that survives a rename: whatever a future
  // step is called and however it reaches the host, it needs credentials, and
  // these five are the only ones that ever pointed at the droplet or the
  // Cloudflare cache. They still exist in GitHub; nothing here may consume
  // them.
  test('the publish job references none of the retired host/Cloudflare secrets', () => {
    const job = JSON.stringify(workflow.jobs?.['publish-cli-release'] ?? {})
    for (const secretName of [
      'PLATFORM_DEPLOY_KEY',
      'PLATFORM_HOST',
      'PLATFORM_HOST_KEY',
      'CLOUDFLARE_CACHE_PURGE_TOKEN',
      'CLOUDFLARE_ZONE_ID',
    ]) {
      expect({ secretName, referenced: job.includes(secretName) }).toEqual({ secretName, referenced: false })
    }
  })

  test('the GitHub release is the delivery surface, with unmatched files failing the run', () => {
    expect(releaseStepIndexes.length).toBeGreaterThan(0)
    const strict = releaseStepIndexes.filter(({ step }) => step.with?.fail_on_unmatched_files === true)
    expect(strict.length).toBe(releaseStepIndexes.length)
  })

  test('Collect release assets copies install.sh and setup.sh into the published set', () => {
    const run = String(steps[indexOfStep('Collect release assets')]?.run ?? '')
    expect(run).toContain('scripts/install.sh')
    expect(run).toContain('dist/release/install.sh')
    expect(run).toContain('scripts/setup.sh')
    expect(run).toContain('dist/release/setup.sh')
  })

  test('every release step runs AFTER the assets are collected', () => {
    const collect = indexOfStep('Collect release assets')
    for (const { step, index } of releaseStepIndexes) {
      expect({ name: step.name, after: index > collect }).toEqual({ name: step.name, after: true })
    }
  })
})
