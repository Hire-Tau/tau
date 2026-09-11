import { describe, expect, it } from 'bun:test'
import type { ManagedToolchainRequest } from '../types'
import { DockerSandboxManager } from '../docker/manager'
import { reconcileRemoteToolchain } from './remote-adapter'

type Result = 'unchanged' | 'applied' | 'cleared'
type Failure = 'install' | 'setup' | 'activation' | undefined
interface Harness {
  calls: string[]
  marker?: string
  failure?: Failure
  reconcile(request: ManagedToolchainRequest): Promise<Result>
}

type HarnessFactory = () => Harness

/** Shared behavioral contract required of every managed-toolchain runtime adapter. */
function managedToolchainAdapterContract(runtime: string, factory: HarnessFactory): void {
  describe(`${runtime} managed-toolchain adapter contract`, () => {
    const request = (setupScript?: string): ManagedToolchainRequest => ({
      config: { packages: ['python3@latest'], ...(setupScript ? { setupScript } : {}) },
      fingerprint: 'fingerprint-b',
      devboxJson: '{"packages":["python3@latest"]}',
      reportStage: async () => {},
    })

    it('refreshes activation for an unchanged marker without reinstalling', async () => {
      const h = factory()
      h.marker = 'fingerprint-b'
      expect(await h.reconcile(request())).toBe('unchanged')
      expect(h.calls).toContain('activation')
      expect(h.calls).not.toContain('install')
    })

    it('reconciles drift in install/setup/activation/marker order', async () => {
      const h = factory()
      h.marker = 'fingerprint-a'
      expect(await h.reconcile(request('echo ready'))).toBe('applied')
      const relevant = h.calls.filter((call) => ['install', 'setup', 'activation', 'marker'].includes(call))
      expect(relevant).toEqual(['install', 'setup', 'activation', 'marker'])
    })

    for (const failure of ['install', 'setup', 'activation'] as const) {
      it(`${failure} failure publishes no readiness marker`, async () => {
        const h = factory()
        h.failure = failure
        await expect(h.reconcile(request('echo ready'))).rejects.toBeDefined()
        expect(h.calls).not.toContain('marker')
      })
    }

    it('is retryable after failure', async () => {
      const h = factory()
      h.failure = 'install'
      await expect(h.reconcile(request())).rejects.toBeDefined()
      h.failure = undefined
      h.calls.length = 0
      expect(await h.reconcile(request())).toBe('applied')
      expect(h.calls).toContain('marker')
    })

    it('clears activation without touching user-owned project files', async () => {
      const h = factory()
      expect(await h.reconcile({ reportStage: async () => {} })).toBe('cleared')
      expect(h.calls).toContain('clear')
      expect(h.calls.some((call) => call.includes('project-owned'))).toBe(false)
    })
  })
}

function remoteHarness(): Harness {
  const h: Harness = {
    calls: [],
    async reconcile(request) {
      return reconcileRemoteToolchain(client as any, '/managed', '/workspace', request)
    },
  }
  const client = {
    read: async () => ({ content: Buffer.from(h.marker ?? '').toString('base64') }),
    write: async ({ path }: { path: string }) => {
      if (path.endsWith('/.ready')) {
        h.calls.push('marker')
        h.marker = 'fingerprint-b'
      }
    },
    bash: ({ command }: { command: string }) => {
      const kind = command.includes('devbox install')
        ? 'install'
        : command.includes('devbox run')
          ? 'setup'
          : command.startsWith('rm ')
            ? 'clear'
            : 'other'
      h.calls.push(kind)
      const stream = new EventTarget() as any
      queueMicrotask(() => {
        stream.dispatchEvent(new MessageEvent('data', { data: { exitCode: h.failure === kind ? 1 : 0 } }))
        stream.dispatchEvent(new Event('end'))
      })
      stream.on = (event: string, listener: (value?: unknown) => void) => {
        stream.addEventListener(event, (value: MessageEvent) => listener(value.data))
        return stream
      }
      stream.cancel = () => {}
      return stream
    },
    toolchainReady: async (active = true) => {
      if (active) h.calls.push('activation')
      else h.calls.push('clear')
      if (active && h.failure === 'activation') throw new Error('activation failed')
    },
  }
  return h
}

function dockerHarness(): Harness {
  const manager = new DockerSandboxManager()
  ;(manager as any).sandboxes.set('contract', {
    containerId: 'fake',
    workspacePath: '/host/workspace',
    workspaceMount: '/workspace',
    sandboxId: 'contract',
    runtime: 'docker-socket',
  })
  ;(manager as any).ensureBashrc = () => {}
  const h: Harness = {
    calls: [],
    async reconcile(request) {
      const result = await manager.reconcileToolchain('contract', { workspacePath: '/host/workspace' }, request)
      if (result === 'applied') h.marker = request.fingerprint
      return result
    },
  }
  manager.execToolchainStatus = async (_id, args) => {
    const command = args.join(' ')
    let kind = 'other'
    if (command.includes('cat -- .ready')) return { exitCode: h.marker === 'fingerprint-b' ? 0 : 1, timedOut: false }
    if (command.includes('devbox install')) kind = 'install'
    else if (command.includes('devbox run')) kind = 'setup'
    else if (command.includes('devbox shellenv')) kind = 'activation'
    else if (command.includes("rm -f -- '.ready'")) kind = 'clear'
    else if (command.includes("'.ready'")) kind = 'marker'
    h.calls.push(kind)
    return { exitCode: h.failure === kind ? 1 : 0, timedOut: false }
  }
  return h
}

managedToolchainAdapterContract('Docker', dockerHarness)
managedToolchainAdapterContract('Kubernetes remote', remoteHarness)
managedToolchainAdapterContract('VM remote', remoteHarness)
