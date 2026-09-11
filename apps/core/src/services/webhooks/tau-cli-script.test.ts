import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const repoRoot = join(__dirname, '../../../../..')
const resolver = join(repoRoot, 'config/webhooks/scripts/tau-cli.sh')

describe('tau-cli.sh resolver', () => {
  it('runs the CLI from source when no dist build exists (the tenant case)', () => {
    // The resolver must produce a working CLI without apps/cli/dist. Proven by
    // reaching the CLI's own arg parsing: --help exits 0 and prints usage.
    const run = spawnSync('bash', [resolver, '--help'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env } })
    expect(run.status).toBe(0)
    expect(`${run.stdout}${run.stderr}`.toLowerCase()).toContain('workstream')
  })
})
