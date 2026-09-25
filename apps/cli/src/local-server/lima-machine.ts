import { join } from 'path'
import type { Runner } from './runner'

/**
 * A local Lima VM registered as a BYO-SSH machine, so a laptop Core running
 * `TAU_SANDBOX_RUNTIME=vm` executes agents inside a VM instead of on the host.
 * Boxes are the usual unix users on that one VM; Core reaches it over SSH on a
 * pinned loopback port and boxes call Core back over the machine's reverse
 * tunnel, so the guest never needs a route to the host.
 */

export const LIMA_DEFAULTS = {
  instance: 'tau-machine',
  machineName: 'lima-local',
  cpus: 4,
  memoryGiB: 8,
  diskGiB: 60,
  sshPort: 60922,
} as const

/** Lima's user-mode network: the host is the gateway, which also serves DNS. */
const LIMA_HOST_IP = '192.168.5.2'
const LIMA_SUBNET = '192.168.5.0/24'
const BOOTSTRAP_POLL_MS = 5_000
/** Core's own bootstrap SSH deadline is 15 minutes; outwait it slightly. */
const BOOTSTRAP_DEADLINE_MS = 16 * 60_000

/**
 * Guest firewall. Lima lets the guest reach every service on the host's
 * loopback (Postgres, the Core API, anything else listening) through the
 * gateway. Boxes never need that path, so drop all of it except DNS. Box users
 * are not sudoers, so they cannot lift it. Installed as a oneshot unit so it
 * survives reboots.
 *
 * sshd's own replies are accepted by source port, not just by conntrack state:
 * on a fresh VM nothing has loaded conntrack yet, so the SSH session installing
 * this rule is picked up mid-stream as `new` and would otherwise be cut off.
 * Unprivileged users cannot bind port 22, so boxes gain nothing from it.
 */
export const HOST_GUARD_SCRIPT = `set -eu
cat > /etc/tau-lima-host-guard.nft <<'EOF'
table inet tau_lima_host_guard {
  chain output {
    type filter hook output priority 0; policy accept;
    ct state established,related accept
    tcp sport 22 accept
    ip daddr ${LIMA_HOST_IP} udp dport 53 accept
    ip daddr ${LIMA_HOST_IP} tcp dport 53 accept
    ip daddr ${LIMA_SUBNET} drop
  }
}
EOF
cat > /etc/systemd/system/tau-lima-host-guard.service <<'EOF'
[Unit]
Description=Block guest access to the Lima host (DNS excepted)
Before=network-pre.target
Wants=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet tau_lima_host_guard
ExecStart=/usr/sbin/nft -f /etc/tau-lima-host-guard.nft
ExecStop=/usr/sbin/nft delete table inet tau_lima_host_guard
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tau-lima-host-guard.service >/dev/null
systemctl restart tau-lima-host-guard.service
`

export interface LimaUpOptions {
  instance: string
  machineName: string
  cpus: number
  memoryGiB: number
  diskGiB: number
  sshPort: number
  dryRun?: boolean
}

interface LimaInstance {
  name: string
  status: string
  sshLocalPort?: number
}

export interface LimaMachine {
  id: string
  name: string
  provider: string
  status: string
  sshHost?: string
  sshPort?: number
  sshPublicKey?: string | null
  lastError?: string | null
  capabilities?: Record<string, unknown>
}

export interface LimaMachineDeps {
  runner: Runner
  platform: NodeJS.Platform
  api: {
    get<T>(path: string): Promise<T>
    post<T>(path: string, body?: unknown): Promise<T>
  }
  log(message: string): void
  sleep(ms: number): Promise<void>
  now(): number
  /** Per-instance host state (the stable SSH host key) lives under here. */
  stateDir: string
  fs: {
    exists(path: string): boolean
    read(path: string): string
    mkdirp(path: string): void
  }
}

export function limaCreateCommand(opts: LimaUpOptions, platform: NodeJS.Platform): string[] {
  // Port forwarding off: Lima would otherwise publish every guest listener on
  // the host (including 0.0.0.0 for some). Core only needs the SSH port, which
  // Lima forwards separately and which is pinned so the machine row stays valid
  // across VM restarts.
  const set = [
    `.ssh.localPort = ${opts.sshPort}`,
    '.portForwards = [{"guestIP": "0.0.0.0", "guestPortRange": [1, 65535], "ignore": true, "proto": "any"}, {"guestIP": "127.0.0.1", "guestPortRange": [1, 65535], "ignore": true, "proto": "any"}]',
  ].join(' | ')
  return [
    'limactl',
    'start',
    `--name=${opts.instance}`,
    '--tty=false',
    ...(platform === 'darwin' ? ['--vm-type=vz'] : []),
    `--cpus=${opts.cpus}`,
    `--memory=${opts.memoryGiB}`,
    `--disk=${opts.diskGiB}`,
    // No host directories in the guest: that is the point.
    '--mount-none',
    `--set=${set}`,
    'template:ubuntu-24.04',
  ]
}

async function run(deps: LimaMachineDeps, command: string[], what: string, inherit = false): Promise<string> {
  const result = await deps.runner(command, { inherit })
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
}

async function findInstance(deps: LimaMachineDeps, instance: string): Promise<LimaInstance | undefined> {
  const stdout = await run(deps, ['limactl', 'list', '--json'], 'limactl list')
  // One JSON object per line.
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parsed = JSON.parse(line) as LimaInstance
    if (parsed.name === instance) return parsed
  }
  return undefined
}

/** Run a shell script inside the guest without depending on argument quoting. */
function guestScript(instance: string, script: string, sudo: boolean): string[] {
  const encoded = Buffer.from(script).toString('base64')
  return [
    'limactl',
    'shell',
    instance,
    '--',
    ...(sudo ? ['sudo'] : []),
    'bash',
    '-c',
    `echo ${encoded} | base64 -d | bash`,
  ]
}

/**
 * Core pins each machine's SSH host key by host:port. A recreated VM would
 * present a new key on the same loopback port and Core would refuse it forever,
 * so the instance keeps one ed25519 host key across VM lifetimes. Core's ssh
 * negotiates ed25519 first (and prefers the type it already pinned), so the
 * guest's other generated key types never come into play.
 */
async function stableHostKey(deps: LimaMachineDeps, instance: string): Promise<{ key: string; pub: string }> {
  const dir = join(deps.stateDir, instance)
  const keyPath = join(dir, 'ssh_host_ed25519_key')
  if (!deps.fs.exists(keyPath)) {
    deps.fs.mkdirp(dir)
    await run(
      deps,
      ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `tau-lima-${instance}`, '-f', keyPath],
      'ssh-keygen'
    )
  }
  return { key: deps.fs.read(keyPath), pub: deps.fs.read(`${keyPath}.pub`) }
}

function hostKeyScript(hostKey: { key: string; pub: string }): string {
  return `set -eu
umask 077
cat > /tmp/tau-host-key <<'EOF'
${hostKey.key.trim()}
EOF
if ! cmp -s /tmp/tau-host-key /etc/ssh/ssh_host_ed25519_key; then
  install -m 600 -o root -g root /tmp/tau-host-key /etc/ssh/ssh_host_ed25519_key
  cat > /etc/ssh/ssh_host_ed25519_key.pub <<'EOF'
${hostKey.pub.trim()}
EOF
  chmod 644 /etc/ssh/ssh_host_ed25519_key.pub
  systemctl restart ssh
fi
rm -f /tmp/tau-host-key
`
}

function authorizeKeyScript(publicKey: string): string {
  const key = publicKey.trim()
  return `set -eu
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
grep -qxF '${key}' ~/.ssh/authorized_keys || echo '${key}' >> ~/.ssh/authorized_keys
`
}

export async function limaMachineUp(opts: LimaUpOptions, deps: LimaMachineDeps): Promise<LimaMachine | undefined> {
  const version = await deps.runner(['limactl', '--version'])
  if (version.code !== 0) {
    throw new Error('limactl not found. Install Lima first (macOS: brew install lima).')
  }

  const existing = await findInstance(deps, opts.instance)
  const plan: string[] = []
  if (!existing) plan.push(`create + boot VM: ${limaCreateCommand(opts, deps.platform).join(' ')}`)
  else if (existing.status !== 'Running') plan.push(`boot existing VM: limactl start ${opts.instance}`)
  plan.push(`install a stable SSH host key (kept in ${join(deps.stateDir, opts.instance)})`)
  plan.push(`install the guest host-guard firewall (only DNS may reach ${LIMA_HOST_IP})`)
  plan.push(`register "${opts.machineName}" (127.0.0.1:<ssh port>) with Core, authorize its key, bootstrap`)

  deps.log('Plan:')
  for (const step of plan) deps.log(`  - ${step}`)
  if (opts.dryRun) {
    deps.log('(dry run) nothing was executed.')
    return undefined
  }

  if (!existing) {
    deps.log(`Creating Lima VM "${opts.instance}" (first boot downloads the Ubuntu image)...`)
    await run(deps, limaCreateCommand(opts, deps.platform), 'limactl start', true)
  } else if (existing.status !== 'Running') {
    deps.log(`Starting Lima VM "${opts.instance}"...`)
    await run(deps, ['limactl', 'start', opts.instance, '--tty=false'], 'limactl start', true)
  }

  const instance = await findInstance(deps, opts.instance)
  const sshPort = instance?.sshLocalPort
  if (!sshPort) throw new Error(`Lima VM "${opts.instance}" has no SSH port; is it running?`)
  if (existing && sshPort !== opts.sshPort) {
    deps.log(`Note: existing VM uses SSH port ${sshPort} (--ssh-port applies only at creation).`)
  }

  deps.log('Installing the stable SSH host key and the guest host-guard firewall...')
  const hostKey = await stableHostKey(deps, opts.instance)
  await run(deps, guestScript(opts.instance, hostKeyScript(hostKey), true), 'host key install')
  await run(deps, guestScript(opts.instance, HOST_GUARD_SCRIPT, true), 'host-guard install')

  const sshUser = (await run(deps, ['limactl', 'shell', opts.instance, '--', 'id', '-un'], 'guest user lookup')).trim()

  const machines = await deps.api.get<LimaMachine[]>('/api/machines')
  let machine = machines.find((m) => m.provider === 'ssh' && m.sshHost === '127.0.0.1' && m.sshPort === sshPort)
  if (machine) {
    deps.log(`Machine already registered: ${machine.name} (${machine.id}), status ${machine.status}`)
  } else {
    machine = await deps.api.post<LimaMachine>('/api/machines', {
      name: opts.machineName,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshPort,
      sshUser,
      scope: 'shared',
    })
    deps.log(`Registered machine ${machine.name} (${machine.id})`)
  }
  if (!machine.sshPublicKey) throw new Error(`Core returned no SSH public key for machine ${machine.id}`)
  await run(deps, guestScript(opts.instance, authorizeKeyScript(machine.sshPublicKey), false), 'authorize Core key')

  if (machine.status === 'ready') {
    deps.log('Machine is ready.')
    return machine
  }

  deps.log('Bootstrapping the machine (a fresh VM takes several minutes: docker, nix, devbox, browser)...')
  if (machine.status !== 'bootstrapping') {
    await deps.api.post<LimaMachine>(`/api/machines/${machine.id}/bootstrap`)
  }
  const started = deps.now()
  let lastReport = started
  for (;;) {
    await deps.sleep(BOOTSTRAP_POLL_MS)
    machine = await deps.api.get<LimaMachine>(`/api/machines/${machine.id}`)
    if (machine.status !== 'bootstrapping') break
    const now = deps.now()
    if (now - started > BOOTSTRAP_DEADLINE_MS) {
      throw new Error(`Bootstrap still running after ${Math.round((now - started) / 60_000)} minutes; check Core logs`)
    }
    if (now - lastReport >= 30_000) {
      deps.log(`  still bootstrapping (${Math.round((now - started) / 1000)}s)...`)
      lastReport = now
    }
  }
  if (machine.status !== 'ready') {
    throw new Error(`Bootstrap finished with status "${machine.status}": ${machine.lastError ?? 'no error recorded'}`)
  }
  deps.log('Machine is ready.')
  return machine
}

export async function limaMachineDown(instance: string, deps: LimaMachineDeps): Promise<void> {
  const existing = await findInstance(deps, instance)
  if (!existing) throw new Error(`No Lima VM named "${instance}"`)
  if (existing.status !== 'Running') {
    deps.log(`Lima VM "${instance}" is already ${existing.status.toLowerCase()}.`)
    return
  }
  await run(deps, ['limactl', 'stop', instance], 'limactl stop', true)
  deps.log(`Stopped "${instance}". Core marks the machine unreachable; \`tau machines lima up\` brings it back.`)
}
