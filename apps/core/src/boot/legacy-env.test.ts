import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')

/** The caller's env without any TAU_/FICUS_ names, so each case controls exactly what is bridged. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('TAU_') || key.startsWith('FICUS_')) continue
    env[key] = value
  }
  return { ...env, NO_COLOR: '1', ...extra }
}

function runBoot(script: string, extra: Record<string, string>) {
  const proc = Bun.spawnSync(['bun', '-e', `import './apps/core/src/boot/legacy-env'; ${script}`], {
    cwd: REPO_ROOT,
    env: cleanEnv(extra),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

describe('core legacy-env boot module', () => {
  test('removes every TAU_ variable from process.env', () => {
    const result = runBoot(`console.log(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith('TAU_'))))`, {
      TAU_X: '1',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim().split('\n').at(-1)).toBe('[]')
  })

  test('warns with the moved names and exposes the value under FICUS_', () => {
    const result = runBoot(`console.log('value=' + process.env.FICUS_X)`, { TAU_X: '1' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout + result.stderr).toContain('legacy TAU_* environment moved to FICUS_*: TAU_X')
    expect(result.stdout).toContain('value=1')
  })

  test('logs nothing at warn level when FICUS_ already wins', () => {
    const result = runBoot(`console.log('value=' + process.env.FICUS_X)`, { TAU_X: 'old', FICUS_X: 'new' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout + result.stderr).not.toContain('moved to FICUS_*')
    expect(result.stdout + result.stderr).toContain('legacy TAU_* variables ignored (FICUS_ already set): 1')
    expect(result.stdout).toContain('value=new')
  })

  test('a conflicting encryption key keeps the TAU_ value and logs names only (N-I2)', () => {
    const result = runBoot(`console.log('value=' + process.env.FICUS_ENCRYPTION_KEY)`, {
      TAU_ENCRYPTION_KEY: 'legacy-key-value',
      FICUS_ENCRYPTION_KEY: 'stray-key-value',
    })
    expect(result.exitCode).toBe(0)
    const logs = result.stdout.replace('value=legacy-key-value', '') + result.stderr
    expect(logs).toContain('legacy TAU_* and FICUS_* disagree for: TAU_ENCRYPTION_KEY')
    expect(logs).not.toContain('legacy-key-value')
    expect(logs).not.toContain('stray-key-value')
    expect(result.stdout).toContain('value=legacy-key-value')
  })
})

describe('entrypoints import the legacy-env boot module first', () => {
  // Later imports read process.env at module load, so the bridge must run before any of them.
  const ENTRYPOINTS: Array<[file: string, specifier: string]> = [
    ['apps/core/src/index.ts', './boot/legacy-env'],
    ['apps/core/src/worker.ts', './boot/legacy-env'],
    ['apps/core/src/db/run-migrations.ts', '../boot/legacy-env'],
    ['apps/core/src/box-control.ts', './boot/legacy-env'],
    ['apps/core/src/smoke-configured-extensions.ts', './boot/legacy-env'],
    ['apps/core/src/scripts/update-offline.ts', '../boot/legacy-env'],
    ['apps/cli/src/index.ts', './boot/legacy-env'],
    ['scripts/pm2-name.ts', '../apps/cli/src/boot/legacy-env'],
    ['packages/k8s-sandbox/src/server.ts', './boot/legacy-env'],
  ]

  test.each(ENTRYPOINTS)('%s', (file, specifier) => {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8')
    const firstImport = source.match(/^import\b[^\n]*$/m)?.[0]
    expect(firstImport).toBe(`import '${specifier}'`)
  })
})
