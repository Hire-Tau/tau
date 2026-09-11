import { describe, expect, it } from 'bun:test'
import type { Machine } from '../queries'
import type { ExeApi, ExeVm } from './exe-api'
import { createExeMachineProvider } from './exe'

function fakeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'machine-1',
    name: 'exe-machine',
    provider: 'exe',
    providerRef: 'vm-abc',
    sshHost: 'vm-abc.exe.xyz',
    sshPort: 22,
    sshUser: 'exedev',
    sshKeyId: 'exe-provider-ssh-key',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    bootstrapVersion: null,
    lastSeenAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Machine
}

function fakeApi(overrides: Partial<ExeApi> = {}): ExeApi {
  return {
    createVm: async () => {
      throw new Error('not stubbed: createVm')
    },
    destroyVm: async () => {
      throw new Error('not stubbed: destroyVm')
    },
    getVm: async () => {
      throw new Error('not stubbed: getVm')
    },
    ...overrides,
  }
}

const sampleVm: ExeVm = {
  name: 'vm-abc',
  sshHost: 'vm-abc.exe.xyz',
  sshPort: 22,
  sshUser: 'exedev',
  ref: 'vm-abc',
}

describe('exe machine provider', () => {
  it('has key "exe"', () => {
    expect(createExeMachineProvider({ api: fakeApi() }).key).toBe('exe')
  })

  it('provision() creates a VM by name (ignoring publicKey/sizeHint) and returns its endpoint', async () => {
    let createArgs: { name: string } | undefined
    const provider = createExeMachineProvider({
      api: fakeApi({
        createVm: async (opts) => {
          createArgs = opts
          return sampleVm
        },
      }),
    })

    // publicKey + sizeHint are passed by callers but exe ignores them (account
    // key already reaches every VM; sizing uses defaults).
    const provisioned = await provider.provision({
      name: 'agent-42',
      sizeHint: 'small',
      publicKey: 'ssh-ed25519 AAAA ignored',
    })

    expect(createArgs).toEqual({ name: 'agent-42' })
    expect(provisioned).toEqual({
      sshHost: 'vm-abc.exe.xyz',
      sshPort: 22,
      sshUser: 'exedev',
      providerRef: 'vm-abc',
    })
  })

  it('provision() threads the configured image through to createVm', async () => {
    let createArgs: { name: string; image?: string } | undefined
    const provider = createExeMachineProvider({
      api: fakeApi({
        createVm: async (opts) => {
          createArgs = opts
          return sampleVm
        },
      }),
      image: 'ghcr.io/hire-tau/tau-machine:latest',
    })

    await provider.provision({ name: 'agent-42' })

    expect(createArgs).toEqual({ name: 'agent-42', image: 'ghcr.io/hire-tau/tau-machine:latest' })
  })

  it('provision() passes no image when none is configured (exe uses its default)', async () => {
    let createArgs: { name: string; image?: string } | undefined
    const provider = createExeMachineProvider({
      api: fakeApi({
        createVm: async (opts) => {
          createArgs = opts
          return sampleVm
        },
      }),
    })

    await provider.provision({ name: 'agent-42' })

    expect(createArgs).toEqual({ name: 'agent-42' })
  })

  it('terminate() destroys the VM by its providerRef', async () => {
    let destroyedRef: string | undefined
    const provider = createExeMachineProvider({
      api: fakeApi({
        destroyVm: async (ref) => {
          destroyedRef = ref
        },
      }),
    })

    await provider.terminate(fakeMachine({ providerRef: 'vm-xyz' }))

    expect(destroyedRef).toBe('vm-xyz')
  })

  it('terminate() throws when the machine has no providerRef', async () => {
    const provider = createExeMachineProvider({ api: fakeApi() })
    await expect(provider.terminate(fakeMachine({ providerRef: null }))).rejects.toThrow()
  })

  it('status() maps a running VM to "running"', async () => {
    let queriedRef: string | undefined
    const provider = createExeMachineProvider({
      api: fakeApi({
        getVm: async (ref) => {
          queriedRef = ref
          return { state: 'running' }
        },
      }),
    })

    await expect(provider.status(fakeMachine({ providerRef: 'vm-abc' }))).resolves.toBe('running')
    expect(queriedRef).toBe('vm-abc')
  })

  it('status() maps a stopped VM to "parked"', async () => {
    const provider = createExeMachineProvider({
      api: fakeApi({ getVm: async () => ({ state: 'stopped' }) }),
    })
    await expect(provider.status(fakeMachine())).resolves.toBe('parked')
  })

  it('status() maps a null (absent) VM to "gone"', async () => {
    const provider = createExeMachineProvider({
      api: fakeApi({ getVm: async () => null }),
    })
    await expect(provider.status(fakeMachine())).resolves.toBe('gone')
  })

  it('status() maps an explicit "gone" state to "gone"', async () => {
    const provider = createExeMachineProvider({
      api: fakeApi({ getVm: async () => ({ state: 'gone' }) }),
    })
    await expect(provider.status(fakeMachine())).resolves.toBe('gone')
  })

  it('status() returns "gone" when the machine has no providerRef', async () => {
    let called = false
    const provider = createExeMachineProvider({
      api: fakeApi({
        getVm: async () => {
          called = true
          return { state: 'running' }
        },
      }),
    })
    await expect(provider.status(fakeMachine({ providerRef: null }))).resolves.toBe('gone')
    expect(called).toBe(false)
  })

  it('park() is a documented no-op (exe idle ≈ free)', async () => {
    const provider = createExeMachineProvider({ api: fakeApi() })
    await expect(provider.park!(fakeMachine())).resolves.toBeUndefined()
  })

  it('resume() is a documented no-op (exe idle ≈ free)', async () => {
    const provider = createExeMachineProvider({ api: fakeApi() })
    await expect(provider.resume!(fakeMachine())).resolves.toBeUndefined()
  })
})
