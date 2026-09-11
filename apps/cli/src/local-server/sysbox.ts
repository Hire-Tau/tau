import { existsSync, readFileSync } from 'fs'
import { release as osRelease } from 'os'
import type { Runner } from './runner'
import { SetupFailure } from './types'

/** The sysbox release pinned in docs/wiki/sandbox-runtimes.md §Installing sysbox. */
export const SYSBOX_VERSION = '0.6.6'
export const SYSBOX_DEB_NAME = `sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb`
export const SYSBOX_DEB_URL = `https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB_NAME}`
/**
 * sha256 of the pinned .deb, computed by downloading it once — Nestybox
 * publishes no checksum. TOFU pinning: consent covers THIS artifact, so a
 * future compromise of the downloads URL cannot substitute a different deb
 * between what the plan shows and what dpkg installs. Repin when SYSBOX_VERSION
 * changes (download once, sha256sum).
 */
export const SYSBOX_DEB_SHA256 = '87cfa5cad97dc5dc1a243d6d88be1393be75b93a517dc1580ecd8a2801c2777a'
/** [major, minor] — sysbox requires Linux >= 5.12. */
export const SYSBOX_MIN_KERNEL = [5, 12] as const

const MANUAL = 'docs/wiki/sandbox-runtimes.md#installing-sysbox'
/** Where the manual recipe (this command automates it) is documented. */
export const SYSBOX_MANUAL_POINTER = MANUAL

/**
 * Whether a `uname -r` style release meets sysbox's 5.12 kernel minimum.
 * Parse-tolerant: anything that does not start `N.N` fails the check rather
 * than being assumed fine.
 */
export function meetsSysboxKernel(kernelRelease: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(kernelRelease.trim())
  if (!m) return false
  const [major, minor] = SYSBOX_MIN_KERNEL
  const [gotMajor, gotMinor] = [Number(m[1]), Number(m[2])]
  if (gotMajor !== major) return gotMajor > major
  return gotMinor >= minor
}

/** What checkSysboxHost needs to know about the host — all injectable. */
export interface SysboxHostDeps {
  platform: NodeJS.Platform
  arch: string
  kernelRelease: string
  systemdActive: boolean
  wsl: boolean
  which(cmd: string): string | null
}

export interface SysboxHostCheck {
  ok: boolean
  /** Each failure is actionable on its own and ends with the manual pointer. */
  failures: string[]
}

/**
 * Whether this host can run the sysbox bootstrap at all. Every unmet
 * capability is a failure listing what to do instead — the command degrades
 * to guidance, never to a doomed attempt.
 */
export function checkSysboxHost(deps: SysboxHostDeps): SysboxHostCheck {
  const failures: string[] = []
  if (deps.platform !== 'linux') {
    failures.push(
      `sysbox is Linux-only (this host is ${deps.platform}); on macOS choose docker-socket, or follow ${MANUAL}`
    )
  }
  if (deps.arch !== 'x64') {
    failures.push(`sysbox publishes amd64 .debs only (this host is ${deps.arch}), or follow ${MANUAL}`)
  }
  if (!meetsSysboxKernel(deps.kernelRelease)) {
    failures.push(
      `kernel ${deps.kernelRelease} is older than sysbox's minimum ${SYSBOX_MIN_KERNEL.join('.')}, or follow ${MANUAL}`
    )
  }
  if (!deps.systemdActive) {
    failures.push(
      deps.wsl
        ? `sysbox needs systemd, which WSL disables by default: add "[boot]\\nsystemd=true" to /etc/wsl.conf, run "wsl --shutdown" from PowerShell and reopen the distro, or follow ${MANUAL}`
        : `sysbox needs systemd (not detected on this host), or follow ${MANUAL}`
    )
  }
  if (!deps.which('dpkg') || !deps.which('apt-get')) {
    const missing = ['dpkg', 'apt-get'].filter((cmd) => !deps.which(cmd)).join(' and ')
    failures.push(
      `the bootstrap installs with ${missing}, which is not installed — use the manual recipe, or follow ${MANUAL}`
    )
  }
  if (!deps.which('sudo')) {
    failures.push(`the bootstrap needs sudo to install and to restart the docker daemon, or follow ${MANUAL}`)
  }
  if (!deps.which('docker')) {
    failures.push(`docker is required (its daemon restarts, and it registers sysbox-runc), or follow ${MANUAL}`)
  }
  return { ok: failures.length === 0, failures }
}

/**
 * This host's SysboxHostDeps, with only `which` injectable (the command
 * wiring passes the CLI's which). All probes are cheap and side-effect free.
 */
export function defaultSysboxHostDeps(which: (cmd: string) => string | null): SysboxHostDeps {
  let wsl = false
  try {
    wsl = readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    // Not readable (not Linux, or a stripped container): assume not WSL.
  }
  return {
    platform: process.platform,
    arch: process.arch,
    kernelRelease: osRelease(),
    systemdActive: existsSync('/run/systemd/system'),
    wsl,
    which,
  }
}

/**
 * The ordered, reviewable install plan — exactly the recipe documented in
 * docs/wiki/sandbox-runtimes.md §Installing sysbox, plus a sha256 verify of the
 * downloaded deb against the pinned digest so install is of THIS artifact.
 * The destructive docker step is NOT here: it is built at runtime from the
 * containers actually present (see runSysboxBootstrap).
 */
export function sysboxInstallCommands(debPath = `/tmp/${SYSBOX_DEB_NAME}`): string[][] {
  return [
    ['wget', '-O', debPath, SYSBOX_DEB_URL],
    // sha256sum -c reads a checklist from stdin: "<digest>  <path>".
    ['bash', '-c', `echo '${SYSBOX_DEB_SHA256}  ${debPath}' | sha256sum -c -`],
    ['sudo', 'apt-get', 'install', '-y', 'jq'],
    ['sudo', 'dpkg', '-i', debPath],
  ]
}

/** Everything runSysboxBootstrap needs — all injectable for tests. */
export interface SysboxBootstrapDeps {
  runner: Runner
  isTTY: boolean
  confirm(message: string): Promise<boolean>
  host: SysboxHostDeps
  log(message?: string): void
}

/**
 * Install the sysbox runtime this host needs for `--runtime docker-sysbox`:
 * guarded, consent-gated, dry-runnable. Refuses cleanly when the host cannot
 * run it; when it can, prints the exact plan (naming the containers that will
 * be removed), asks for consent without --yes, executes, and verifies that
 * docker registered sysbox-runc.
 */
export async function runSysboxBootstrap(
  opts: { yes?: boolean; dryRun?: boolean },
  deps: SysboxBootstrapDeps
): Promise<void> {
  const host = checkSysboxHost(deps.host)
  if (!host.ok) {
    throw new SetupFailure(`This host cannot run the sysbox bootstrap:\n  - ${host.failures.join('\n  - ')}`)
  }

  const ps = await deps.runner(['docker', 'ps', '-a', '--format', '{{.Names}}'])
  const containers = ps.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  deps.log('Plan:')
  for (const command of sysboxInstallCommands()) deps.log(`  ${command.join(' ')}`)
  deps.log('')
  deps.log(
    `⚠ Installing sysbox restarts the Docker daemon and removes ALL containers (currently: ${
      containers.length ? containers.join(', ') : 'none'
    })`
  )

  if (opts.dryRun) {
    deps.log('(dry run) nothing was executed.')
    return
  }

  if (!opts.yes) {
    if (!deps.isTTY) throw new Error('bootstrap-sysbox needs a terminal to confirm — pass --yes')
    if (!(await deps.confirm('Install sysbox? This removes all Docker containers and restarts the daemon.'))) {
      deps.log('Aborted. Nothing was changed.')
      return
    }
  }

  if (containers.length > 0) {
    const rm = await deps.runner(['docker', 'rm', '-f', ...containers], { inherit: true })
    if (rm.code !== 0) throw new SetupFailure(`docker rm failed:\n${rm.stderr || rm.stdout}`)
  }
  for (const command of sysboxInstallCommands()) {
    const r = await deps.runner(command, { inherit: true })
    if (r.code !== 0) throw new SetupFailure(`${command.join(' ')} failed:\n${r.stderr || r.stdout}`)
  }
  const verify = await deps.runner(['docker', 'info', '--format', '{{json .Runtimes}}'])
  if (!verify.stdout.includes('sysbox-runc')) {
    throw new SetupFailure(
      `sysbox-runc is not registered with docker after the install. If sysbox-mgr failed with "open /proc/modules" (some VPS kernels), disable the shiftfs check with the systemd override documented in ${MANUAL}. Output:\n${
        verify.stderr || verify.stdout
      }`
    )
  }
  deps.log('sysbox installed and registered with docker (sysbox-runc).')
}
