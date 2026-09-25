import { describe, expect, it } from 'bun:test'
import {
  HOST_GUARD_SCRIPT,
  LIMA_DEFAULTS,
  limaCreateCommand,
  limaMachineDown,
  limaMachineUp,
  type LimaMachine,
  type LimaMachineDeps,
} from './lima-machine'
import type { RunResult } from './runner'

const opts = { ...LIMA_DEFAULTS }

interface Harness {
  deps: LimaMachineDeps
  commands: string[][]
  posts: Array<{ path: string; body?: unknown }>
  logs: string[]
}

/**
 * `instances` is what `limactl list --json` reports, as a queue: each list call
 * shifts one entry until the last, which then repeats. `machineStates` does the
 * same for GET /api/machines/:id polls.
 */
function harness(setup: {
  limactl?: boolean
  instances: Array<Array<{ name: string; status: string; sshLocalPort?: number }>>
  machines?: LimaMachine[]
  created?: LimaMachine
  machineStates?: LimaMachine[]
  failGuard?: boolean
  /** Files already on the host (the stable host key); ssh-keygen adds to it. */
  files?: Record<string, string>
}): Harness {
  const commands: string[][] = []
  const posts: Array<{ path: string; body?: unknown }> = []
  const logs: string[] = []
  const instances = [...setup.instances]
  const states = [...(setup.machineStates ?? [])]
  const files: Record<string, string> = { ...(setup.files ?? {}) }
  let clock = 0
  const deps: LimaMachineDeps = {
    platform: 'darwin',
    runner: async (command): Promise<RunResult> => {
      commands.push(command)
      const joined = command.join(' ')
      if (joined === 'limactl --version') {
        return setup.limactl === false
          ? { code: 127, stdout: '', stderr: 'not found' }
          : { code: 0, stdout: 'limactl version 2.2.0', stderr: '' }
      }
      if (joined === 'limactl list --json') {
        const current = instances.length > 1 ? instances.shift()! : instances[0]!
        return { code: 0, stdout: current.map((i) => JSON.stringify(i)).join('\n'), stderr: '' }
      }
      if (joined.endsWith('-- id -un')) return { code: 0, stdout: 'noah\n', stderr: '' }
      if (command[0] === 'ssh-keygen') {
        const path = command.at(-1)!
        files[path] = 'GENERATED-PRIVATE-KEY'
        files[`${path}.pub`] = 'ssh-ed25519 GENERATED tau-lima-tau-machine'
        return { code: 0, stdout: '', stderr: '' }
      }
      if (setup.failGuard && joined.includes(Buffer.from(HOST_GUARD_SCRIPT).toString('base64'))) {
        return { code: 1, stdout: '', stderr: 'nft: syntax error' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    api: {
      get: async <T>(path: string): Promise<T> => {
        if (path === '/api/machines') return (setup.machines ?? []) as T
        const next = states.length > 1 ? states.shift()! : states[0]!
        return next as T
      },
      post: async <T>(path: string, body?: unknown): Promise<T> => {
        posts.push({ path, body })
        if (path === '/api/machines') return setup.created as T
        return {} as T
      },
    },
    log: (line) => logs.push(line),
    sleep: async () => {
      clock += 5_000
    },
    now: () => clock,
    stateDir: '/state/lima',
    fs: {
      exists: (path) => path in files,
      read: (path) => files[path]!,
      mkdirp: () => {},
    },
  }
  return { deps, commands, posts, logs }
}

const machine = (over: Partial<LimaMachine> = {}): LimaMachine => ({
  id: 'm-1',
  name: 'lima-local',
  provider: 'ssh',
  status: 'registered',
  sshHost: '127.0.0.1',
  sshPort: 60922,
  sshPublicKey: 'ssh-ed25519 AAAAC3Nza tau-machine-m-1',
  ...over,
})

/** Decode the script a guestScript() command pipes into the guest. */
function decodedScripts(commands: string[][]): string[] {
  return commands
    .map((c) => c[c.length - 1] ?? '')
    .map((last) => /^echo (\S+) \| base64 -d \| bash$/.exec(last)?.[1])
    .filter((b64): b64 is string => b64 !== undefined)
    .map((b64) => Buffer.from(b64, 'base64').toString('utf8'))
}

describe('limaCreateCommand', () => {
  it('creates an isolated VM: no host mounts, no port forwards, pinned SSH port', () => {
    const cmd = limaCreateCommand({ ...opts, sshPort: 60999 }, 'darwin')
    expect(cmd).toContain('--mount-none')
    expect(cmd).toContain('--vm-type=vz')
    expect(cmd.at(-1)).toBe('template:ubuntu-24.04')
    const set = cmd.find((a) => a.startsWith('--set='))!
    expect(set).toContain('.ssh.localPort = 60999')
    // Both the wildcard and loopback guest listeners are ignored, all protocols.
    expect(set).toContain('"guestIP": "0.0.0.0", "guestPortRange": [1, 65535], "ignore": true, "proto": "any"')
    expect(set).toContain('"guestIP": "127.0.0.1", "guestPortRange": [1, 65535], "ignore": true, "proto": "any"')
  })

  it('only asks for vz on macOS', () => {
    expect(limaCreateCommand(opts, 'linux')).not.toContain('--vm-type=vz')
  })
})

describe('HOST_GUARD_SCRIPT', () => {
  it('lets replies and DNS through, then drops the rest of the host network', () => {
    const established = HOST_GUARD_SCRIPT.indexOf('ct state established,related accept')
    const dns = HOST_GUARD_SCRIPT.indexOf('ip daddr 192.168.5.2 udp dport 53 accept')
    const drop = HOST_GUARD_SCRIPT.indexOf('ip daddr 192.168.5.0/24 drop')
    expect(established).toBeGreaterThan(-1)
    expect(dns).toBeGreaterThan(established)
    // sshd replies survive the rule landing under a session conntrack never saw start.
    expect(HOST_GUARD_SCRIPT.indexOf('tcp sport 22 accept')).toBeLessThan(drop)
    expect(drop).toBeGreaterThan(dns)
    // Persisted across reboots.
    expect(HOST_GUARD_SCRIPT).toContain('systemctl enable tau-lima-host-guard.service')
  })
})

describe('limaMachineUp', () => {
  it('refuses with install guidance when limactl is missing', async () => {
    const h = harness({ limactl: false, instances: [[]] })
    await expect(limaMachineUp(opts, h.deps)).rejects.toThrow('brew install lima')
  })

  it('dry run prints the plan and changes nothing', async () => {
    const h = harness({ instances: [[]] })
    const result = await limaMachineUp({ ...opts, dryRun: true }, h.deps)
    expect(result).toBeUndefined()
    expect(h.commands.map((c) => c.join(' '))).toEqual(['limactl --version', 'limactl list --json'])
    expect(h.posts).toEqual([])
    expect(h.logs.join('\n')).toContain('create + boot VM')
  })

  it('creates, guards, registers, authorizes and bootstraps a fresh VM', async () => {
    const h = harness({
      instances: [[], [{ name: 'tau-machine', status: 'Running', sshLocalPort: 60922 }]],
      created: machine(),
      machineStates: [machine({ status: 'bootstrapping' }), machine({ status: 'ready' })],
    })
    const result = await limaMachineUp(opts, h.deps)
    expect(result?.status).toBe('ready')

    expect(h.commands.some((c) => c[0] === 'limactl' && c[1] === 'start' && c.includes('--mount-none'))).toBe(true)
    expect(h.posts).toEqual([
      {
        path: '/api/machines',
        body: {
          name: 'lima-local',
          provider: 'ssh',
          sshHost: '127.0.0.1',
          sshPort: 60922,
          sshUser: 'noah',
          scope: 'shared',
        },
      },
      { path: '/api/machines/m-1/bootstrap', body: undefined },
    ])

    const scripts = decodedScripts(h.commands)
    expect(scripts[0]).toContain('GENERATED-PRIVATE-KEY')
    expect(scripts[1]).toBe(HOST_GUARD_SCRIPT)
    // The guard runs as root; the key goes into the (non-root) SSH user's file.
    const guard = h.commands.find((c) => c.at(-1)?.includes(Buffer.from(HOST_GUARD_SCRIPT).toString('base64')))!
    expect(guard).toContain('sudo')
    expect(scripts[2]).toContain(
      "grep -qxF 'ssh-ed25519 AAAAC3Nza tau-machine-m-1' ~/.ssh/authorized_keys || echo 'ssh-ed25519 AAAAC3Nza tau-machine-m-1' >> ~/.ssh/authorized_keys"
    )
  })

  it('is idempotent for a running VM whose machine is already ready', async () => {
    const h = harness({
      instances: [[{ name: 'tau-machine', status: 'Running', sshLocalPort: 60922 }]],
      machines: [machine({ status: 'ready' })],
    })
    const result = await limaMachineUp(opts, h.deps)
    expect(result?.status).toBe('ready')
    expect(h.posts).toEqual([])
    expect(h.commands.some((c) => c[1] === 'start')).toBe(false)
    // Still re-applies the host key and guard, and re-checks the authorized key.
    expect(decodedScripts(h.commands)).toHaveLength(3)
  })

  it('keeps one SSH host key per instance so a recreated VM matches what Core pinned', async () => {
    const keyPath = '/state/lima/tau-machine/ssh_host_ed25519_key'
    const running = [{ name: 'tau-machine', status: 'Running', sshLocalPort: 60922 }]

    const first = harness({ instances: [running], machines: [machine({ status: 'ready' })] })
    await limaMachineUp(opts, first.deps)
    const keygen = first.commands.filter((c) => c[0] === 'ssh-keygen')
    expect(keygen).toEqual([
      ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'tau-lima-tau-machine', '-f', keyPath],
    ])

    // A later run (e.g. after `limactl delete`) reuses the saved key.
    const again = harness({
      instances: [[], running],
      machines: [machine({ status: 'ready' })],
      files: { [keyPath]: 'SAVED-PRIVATE-KEY', [`${keyPath}.pub`]: 'ssh-ed25519 SAVED tau-lima-tau-machine' },
    })
    await limaMachineUp(opts, again.deps)
    expect(again.commands.some((c) => c[0] === 'ssh-keygen')).toBe(false)
    const [hostKeyScript] = decodedScripts(again.commands)
    expect(hostKeyScript).toContain('SAVED-PRIVATE-KEY')
    expect(hostKeyScript).toContain('ssh-ed25519 SAVED tau-lima-tau-machine')
    // sshd restarts only when the key actually changed.
    expect(hostKeyScript).toContain('if ! cmp -s /tmp/tau-host-key /etc/ssh/ssh_host_ed25519_key; then')
    // It runs as root, before Core is ever asked to connect.
    const install = again.commands.find((c) => c.at(-1)?.includes(Buffer.from(hostKeyScript!).toString('base64')))!
    expect(install).toContain('sudo')
  })

  it('boots a stopped VM without re-creating it', async () => {
    const h = harness({
      instances: [
        [{ name: 'tau-machine', status: 'Stopped' }],
        [{ name: 'tau-machine', status: 'Running', sshLocalPort: 60922 }],
      ],
      machines: [machine({ status: 'ready' })],
    })
    await limaMachineUp(opts, h.deps)
    const start = h.commands.find((c) => c[1] === 'start')!
    expect(start).toEqual(['limactl', 'start', 'tau-machine', '--tty=false'])
  })

  it('does not register the machine when the guard cannot be installed', async () => {
    const h = harness({
      instances: [[{ name: 'tau-machine', status: 'Running', sshLocalPort: 60922 }]],
      failGuard: true,
    })
    await expect(limaMachineUp(opts, h.deps)).rejects.toThrow('host-guard install failed')
    expect(h.posts).toEqual([])
  })

  it('surfaces a failed bootstrap with Core’s recorded error', async () => {
    const h = harness({
      instances: [[{ name: 'tau-machine', status: 'Running', sshLocalPort: 60922 }]],
      machines: [machine({ status: 'unreachable' })],
      machineStates: [machine({ status: 'unreachable', lastError: 'ssh command timed out after 900000ms' })],
    })
    await expect(limaMachineUp(opts, h.deps)).rejects.toThrow('ssh command timed out after 900000ms')
    expect(h.posts).toEqual([{ path: '/api/machines/m-1/bootstrap', body: undefined }])
  })

  it('gives up polling after the deadline instead of hanging', async () => {
    const h = harness({
      instances: [[{ name: 'tau-machine', status: 'Running', sshLocalPort: 60922 }]],
      machines: [machine({ status: 'bootstrapping' })],
      machineStates: [machine({ status: 'bootstrapping' })],
    })
    await expect(limaMachineUp(opts, h.deps)).rejects.toThrow('Bootstrap still running')
    // Joins the in-flight bootstrap rather than starting a second one.
    expect(h.posts).toEqual([])
  })
})

describe('limaMachineDown', () => {
  it('stops a running VM', async () => {
    const h = harness({ instances: [[{ name: 'tau-machine', status: 'Running' }]] })
    await limaMachineDown('tau-machine', h.deps)
    expect(h.commands.at(-1)).toEqual(['limactl', 'stop', 'tau-machine'])
  })

  it('is a no-op for a stopped VM and an error for a missing one', async () => {
    const stopped = harness({ instances: [[{ name: 'tau-machine', status: 'Stopped' }]] })
    await limaMachineDown('tau-machine', stopped.deps)
    expect(stopped.commands.some((c) => c[1] === 'stop')).toBe(false)

    const missing = harness({ instances: [[]] })
    await expect(limaMachineDown('tau-machine', missing.deps)).rejects.toThrow('No Lima VM named')
  })
})
