import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bootstrap, defaultInstallDir, type BootstrapDeps } from './bootstrap'
import { SetupOptionsError } from './options'
import { recordingRunner } from './runner'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tau-boot-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function deps(overrides: Partial<BootstrapDeps> = {}) {
  const rec = recordingRunner()
  const lines: string[] = []
  const d: BootstrapDeps = {
    runner: rec.runner,
    which: (cmd) => (['git', 'bun', 'curl'].includes(cmd) ? `/usr/bin/${cmd}` : null),
    env: {},
    home: tmp,
    log: (l) => lines.push(l),
    ...overrides,
  }
  return { d, calls: rec.calls, lines }
}
const joined = (calls: { command: string[] }[]) => calls.map((c) => c.command.join(' '))

describe('bootstrap', () => {
  it('defaults the install dir to ~/.tau/tau', () => {
    expect(defaultInstallDir('/home/x')).toBe('/home/x/.tau/tau')
  })
  it('clones, installs and execs the checkout setup with pass-through args', async () => {
    const root = join(tmp, 'tau')
    // simulate `git clone` creating a checkout, on top of a plain recording runner
    const rec = recordingRunner()
    const d: BootstrapDeps = {
      runner: async (command, options) => {
        const r = await rec.runner(command, options)
        if (command[0] === 'git' && command[1] === 'clone') {
          mkdirSync(join(root, '.git'), { recursive: true })
          writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tau' }))
        }
        return r
      },
      which: (cmd) => (['git', 'bun', 'curl'].includes(cmd) ? `/usr/bin/${cmd}` : null),
      env: {},
      home: tmp,
      log: () => {},
    }
    await bootstrap({ root, repo: 'https://example/tau.git', ref: 'main', setupArgs: ['--runtime', 'host'] }, d)
    expect(joined(rec.calls)).toEqual([
      `git clone --recurse-submodules --branch main https://example/tau.git ${root}`,
      'bun install --frozen-lockfile',
      `bun run setup -- --root ${root} --runtime host`,
    ])
    expect(rec.calls[2].options.cwd).toBe(root)
    expect(rec.calls[2].options.inherit).toBe(true)
  })
  it('reuses an existing checkout without cloning', async () => {
    const root = join(tmp, 'tau')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tau' }))
    const { d, calls } = deps()
    await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)
    expect(joined(calls)).toEqual(['bun install --frozen-lockfile', `bun run setup -- --root ${root}`])
  })
  it('refuses a non-empty directory that is not a checkout', async () => {
    const root = join(tmp, 'tau')
    mkdirSync(root)
    writeFileSync(join(root, 'file'), 'x')
    const { d } = deps()
    await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)).rejects.toThrow(/not a tau checkout/)
  })
  it('refuses a root that is a regular file (not just a non-empty non-checkout dir)', async () => {
    const root = join(tmp, 'tau')
    writeFileSync(root, 'not a directory')
    const { d } = deps()
    await expect(bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)).rejects.toThrow(/not a tau checkout/)
  })
  it('propagates the checkout setup exit code', async () => {
    const root = join(tmp, 'tau')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tau' }))
    const rec = recordingRunner({ 'bun run setup': { code: 2 } })
    const d: BootstrapDeps = {
      runner: rec.runner,
      which: (cmd) => (['git', 'bun', 'curl'].includes(cmd) ? `/usr/bin/${cmd}` : null),
      env: {},
      home: tmp,
      log: () => {},
    }
    let error: unknown
    try {
      await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(SetupOptionsError)
    expect((error as SetupOptionsError).exitCode).toBe(2)
  })
  it('installs bun via the official installer when missing and uses ~/.bun/bin afterwards', async () => {
    const root = join(tmp, 'tau')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tau' }))
    const { d, calls } = deps({ which: (cmd) => (cmd === 'bun' ? null : `/usr/bin/${cmd}`) })
    await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, d)
    expect(joined(calls)[0]).toBe('sh -c curl -fsSL https://bun.sh/install | bash')
    const install = calls.find((c) => c.command.join(' ') === 'bun install --frozen-lockfile')!
    expect((install.options.env?.PATH ?? '').startsWith(join(tmp, '.bun', 'bin'))).toBe(true)
  })
  // bun's installer unpacks a zip and dies with "unzip is required" on a stock
  // Ubuntu/Debian image; say so before running it, and only when bun is missing.
  it('requires unzip only when bun has to be installed', async () => {
    const missingBoth = deps({ which: (cmd) => (cmd === 'bun' || cmd === 'unzip' ? null : `/usr/bin/${cmd}`) })
    await expect(
      bootstrap({ root: join(tmp, 'tau'), repo: 'x', ref: 'main', setupArgs: [] }, missingBoth.d)
    ).rejects.toThrow(/unzip.*apt install unzip/)
    expect(missingBoth.calls).toHaveLength(0)

    const root = join(tmp, 'tau')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tau' }))
    const bunPresent = deps({ which: (cmd) => (cmd === 'unzip' ? null : `/usr/bin/${cmd}`) })
    await bootstrap({ root, repo: 'x', ref: 'main', setupArgs: [] }, bunPresent.d)
    expect(joined(bunPresent.calls)[0]).toBe('bun install --frozen-lockfile')
  })
  it('requires git', async () => {
    const { d } = deps({ which: (cmd) => (cmd === 'git' ? null : `/usr/bin/${cmd}`) })
    await expect(bootstrap({ root: join(tmp, 'tau'), repo: 'x', ref: 'main', setupArgs: [] }, d)).rejects.toThrow(/git/)
  })
})
