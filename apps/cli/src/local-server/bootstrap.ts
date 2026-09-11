import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { SetupOptionsError } from './options'
import type { Runner } from './runner'
import { isCheckout } from './state'

export const DEFAULT_REPO = 'https://github.com/Hire-Tau/tau.git'
export const defaultInstallDir = (home: string) => join(home, '.tau', 'tau')

export interface BootstrapDeps {
  runner: Runner
  which(cmd: string): string | null
  env: Record<string, string | undefined>
  home: string
  log(line: string): void
}

export interface BootstrapOptions {
  root: string
  repo: string
  ref: string
  /** Forwarded verbatim to the checkout's `bun run setup`. */
  setupArgs: string[]
}

/**
 * The compiled CLI only bootstraps: bun + git + clone + deps. Setup itself is
 * the CHECKOUT's `bun run setup`, so this binary can never run installer logic
 * that does not match the code it is installing.
 */
export async function bootstrap(options: BootstrapOptions, deps: BootstrapDeps): Promise<void> {
  if (!deps.which('git')) throw new Error('git is required (https://git-scm.com) — install it and re-run.')

  let env: Record<string, string | undefined> = { ...deps.env }
  if (!deps.which('bun')) {
    // bun's installer unpacks a zip; stock Ubuntu/Debian images ship without unzip.
    if (!deps.which('unzip')) {
      throw new Error(
        'bun is not installed and its installer needs unzip — install it (Debian/Ubuntu: sudo apt install unzip) and re-run, or install bun yourself first (https://bun.sh).'
      )
    }
    deps.log('bun not found — installing it with the official installer (https://bun.sh)')
    const r = await deps.runner(['sh', '-c', 'curl -fsSL https://bun.sh/install | bash'], { inherit: true })
    if (r.code !== 0) throw new Error('bun installation failed')
    env = { ...env, PATH: [join(deps.home, '.bun', 'bin'), env.PATH].filter(Boolean).join(':') }
  }

  const { root } = options
  if (isCheckout(root)) {
    deps.log(`Using existing checkout ${root}`)
  } else if (existsSync(root) && (!statSync(root).isDirectory() || readdirSync(root).length > 0)) {
    throw new Error(`${root} exists and is not a tau checkout — choose another --root or remove it.`)
  } else {
    deps.log(`Cloning ${options.repo} (${options.ref}) into ${root}`)
    const r = await deps.runner(['git', 'clone', '--recurse-submodules', '--branch', options.ref, options.repo, root], {
      inherit: true,
      env,
    })
    if (r.code !== 0) throw new Error('git clone failed')
  }

  deps.log('Installing dependencies')
  const install = await deps.runner(['bun', 'install', '--frozen-lockfile'], { cwd: root, inherit: true, env })
  if (install.code !== 0) throw new Error('bun install failed')

  deps.log('Handing off to the checkout: bun run setup')
  // Pass --root explicitly: setup resolves its root from cwd, and an inherited
  // TAU_SERVER_ROOT (or a future resolution change) must not retarget the
  // checkout we just cloned.
  const setup = await deps.runner(['bun', 'run', 'setup', '--', '--root', root, ...options.setupArgs], {
    cwd: root,
    inherit: true,
    env,
  })
  if (setup.code !== 0) throw new SetupOptionsError(`setup exited with ${setup.code}`, setup.code)
}
