/**
 * Cached devbox shell environment.
 *
 * Running `devbox shellenv` on every bash command corrupts the container
 * filesystem in privileged k3d pods (causes /usr/bin to disappear).
 * The exact mechanism is unclear but involves devbox/nix performing
 * operations that interact badly with overlayfs in privileged containers.
 *
 * Instead, we capture the shellenv output once when devbox is ready,
 * and inline the cached exports into each command's preamble.
 */

import { execSync } from 'child_process'
import { getDevboxDir, getDevboxJsonPath } from '../paths'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs'

let cachedShellEnv: string | null = null
let cachedManagedToolchainEnv: string | null = null

/**
 * True when devbox.json declares at least one package. An empty package set is
 * the agent (light) box's default: its comfort tools live on the image's global
 * nix profile, so there is no devbox environment to capture. Critically,
 * `devbox shellenv` against an empty/un-realized devbox HANGS until the timeout,
 * and because cacheDevboxShellEnv runs via a synchronous execSync inside the
 * /devbox-ready request handler, that hang blocks the server's whole event loop
 * — freezing /healthz and failing the startup probe for ~30s. Skip it.
 */
export function devboxHasPackages(devboxJson: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(devboxJson, 'utf-8')) as { packages?: unknown }
    return Array.isArray(parsed.packages) && parsed.packages.length > 0
  } catch {
    return false
  }
}

export function prepareDevboxShellEnv(runShellenv?: (cwd: string) => string): boolean {
  const devboxJson = getDevboxJsonPath()
  if (!existsSync(devboxJson)) return false
  try {
    const parsed = JSON.parse(readFileSync(devboxJson, 'utf-8')) as { packages?: unknown }
    if (!Array.isArray(parsed.packages)) return false
    if (parsed.packages.length === 0) {
      cachedShellEnv = null
      return true
    }
  } catch {
    return false
  }
  return runShellenv ? cacheDevboxShellEnv(runShellenv) : cacheDevboxShellEnv()
}

/**
 * Capture devbox shellenv output and cache it.
 * Called once when the /devbox-ready signal is received.
 */
export function cacheDevboxShellEnv(
  runShellenv: (cwd: string) => string = (cwd) =>
    execSync('devbox shellenv --init-hook 2>/dev/null', { encoding: 'utf-8', cwd, timeout: 30_000 })
): boolean {
  const devboxJson = getDevboxJsonPath()
  if (!existsSync(devboxJson)) {
    cachedShellEnv = null
    console.log('[sandbox] No devbox.json found, skipping shellenv cache')
    return false
  }

  if (!devboxHasPackages(devboxJson)) {
    cachedShellEnv = null
    console.log(
      '[sandbox] devbox.json declares no packages, skipping shellenv cache (tools are on the global nix profile)'
    )
    return false
  }

  try {
    const cwd = devboxJson.replace('/devbox.json', '')
    const output = runShellenv(cwd).trim()

    if (output) {
      cachedShellEnv = output
      console.log(`[sandbox] Cached devbox shellenv (${output.length} bytes)`)
      return true
    }
    cachedShellEnv = null
    return false
  } catch (err: any) {
    cachedShellEnv = null
    console.warn(`[sandbox] Failed to cache devbox shellenv: ${err.message}`)
    return false
  }
}

/**
 * Get the cached shellenv script to prepend to commands.
 * Returns empty string if not yet cached or no devbox.json.
 */
export function getDevboxShellEnv(): string {
  return [cachedShellEnv, cachedManagedToolchainEnv].filter(Boolean).join('\n')
}

/** Clear only Tau's managed toolchain activation, preserving the comfort/project cache. */
export function clearManagedToolchainEnv(): void {
  cachedManagedToolchainEnv = null
}

/** Refresh or clear Tau's managed toolchain activation. Failures are observable to Core. */
export function cacheManagedToolchainEnv(
  active = true,
  runShellenv: (cwd: string) => string = (cwd) =>
    execSync('devbox shellenv --init-hook 2>/dev/null', { encoding: 'utf-8', cwd, timeout: 30_000 })
): void {
  const dir = process.env.TAU_TOOLCHAIN_DIR
  if (!active) {
    clearManagedToolchainEnv()
    return
  }
  if (!dir || !existsSync(`${dir}/devbox.json`)) {
    clearManagedToolchainEnv()
    throw new Error('Managed toolchain configuration is unavailable')
  }

  const output = runShellenv(dir).trim()
  if (!output) {
    clearManagedToolchainEnv()
    throw new Error('Managed toolchain activation produced no environment')
  }
  cachedManagedToolchainEnv = output
}

/** Refresh the VM shellenv cache after a routed `devbox add` mutation. */
export function refreshDevboxShellEnvIfDirty(runShellenv?: (cwd: string) => string): void {
  if (!process.env.TAU_BOX_HOME) return
  try {
    const dir = getDevboxDir()
    const markers = readdirSync(dir).filter((name) => name.startsWith('.shellenv-dirty.'))
    if (markers.length === 0) return
    for (const marker of markers) unlinkSync(`${dir}/${marker}`)
    if (runShellenv) cacheDevboxShellEnv(runShellenv)
    else cacheDevboxShellEnv()
  } catch (err) {
    console.warn(`[sandbox] Failed to refresh dirty devbox shellenv: ${String(err)}`)
  }
}

/**
 * Whether the server should cache the devbox shellenv AT BOOT.
 *
 * On k8s/docker the entrypoint POSTs `/devbox-ready` once devbox is realized,
 * which triggers {@link cacheDevboxShellEnv}. A VM "box" has NO entrypoint — the
 * systemd unit execs the server directly — so nothing ever POSTs, and without a
 * boot self-cache the seeded comfort tools (`rg`/`fd`/`gh`) never reach a plain
 * `/bash` PATH (only `devbox run --` sees them). The manager also POSTs
 * `/devbox-ready` right after seeding (the suspenders), but a once-only POST is
 * lost on the next unit restart — so the server self-caches at boot too (the
 * belt).
 *
 * Gated STRICTLY on `TAU_BOX_HOME`, which ONLY a vm box sets, so on k8s/docker
 * this is always false and server boot stays byte-identical (no shellenv work).
 * Also requires a devbox.json that DECLARES packages: an empty/un-realized devbox
 * must never be shellenv'd — `devbox shellenv` HANGS ~30s against it (see
 * {@link devboxHasPackages}), and a boot-time hang would freeze /healthz.
 */
export function shouldSelfCacheDevboxEnvOnBoot(): boolean {
  if (!process.env.TAU_BOX_HOME) return false
  const devboxJson = getDevboxJsonPath()
  return existsSync(devboxJson) && devboxHasPackages(devboxJson)
}

/**
 * Cache the devbox shellenv at server boot on a vm box (see
 * {@link shouldSelfCacheDevboxEnvOnBoot} for the gate). A NO-OP on k8s/docker.
 */
export function selfCacheDevboxEnvOnBoot(runShellenv?: (cwd: string) => string): boolean {
  if (!shouldSelfCacheDevboxEnvOnBoot()) return false
  return runShellenv ? cacheDevboxShellEnv(runShellenv) : cacheDevboxShellEnv()
}
