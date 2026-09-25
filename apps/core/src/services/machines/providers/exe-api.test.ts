import { describe, expect, it } from 'bun:test'
import { MachineProviderError } from '../provider'
import { type ExeExec, type ExeExecResult, createExeApi } from './exe-api'

/**
 * These tests pin the SHAPE of the exe.dev lobby interaction (command args,
 * JSON parsing, error handling) against a FAKE exec. The wire format they assert
 * matches live recon 2026-07-13 (`ssh exe.dev new|ls|rm --json`, `.vms` listing,
 * `vm_name`/`ssh_dest`/`ssh_port` fields, `exedev` SSH user). The real network
 * path (`defaultExeExec`) is exercised only by the gated integration test.
 */

function fakeExec(impl: (args: string[]) => ExeExecResult | Promise<ExeExecResult>): {
  exec: ExeExec
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: ExeExec = async (args) => {
    calls.push(args)
    return impl(args)
  }
  return { exec, calls }
}

function ok(stdout: string): ExeExecResult {
  return { exitCode: 0, stdout, stderr: '' }
}

describe('createExeApi.createVm', () => {
  it('runs `new --name <name> --json` and parses the SSH endpoint from the returned JSON', async () => {
    const { exec, calls } = fakeExec(() =>
      ok(JSON.stringify({ vm_name: 'vm-abc', ssh_dest: 'vm-abc.exe.xyz', ssh_port: 22, https_url: 'https://x' }))
    )
    const api = createExeApi({ token: 't', exec })

    const vm = await api.createVm({ name: 'vm-abc' })

    expect(calls).toEqual([['new', '--name', 'vm-abc', '--json']])
    expect(vm).toEqual({ name: 'vm-abc', sshHost: 'vm-abc.exe.xyz', sshPort: 22, sshUser: 'exedev', ref: 'vm-abc' })
  })

  it('includes `--image <image>` in the `new` argv when an image is provided', async () => {
    const { exec, calls } = fakeExec(() => ok(JSON.stringify({ vm_name: 'vm-img' })))
    const api = createExeApi({ token: 't', exec })

    await api.createVm({ name: 'vm-img', image: 'ghcr.io/ficushq/tau-machine:latest' })

    expect(calls).toEqual([['new', '--name', 'vm-img', '--image', 'ghcr.io/ficushq/tau-machine:latest', '--json']])
  })

  it('omits `--image` from the `new` argv when no image is provided (exe uses its default)', async () => {
    const { exec, calls } = fakeExec(() => ok(JSON.stringify({ vm_name: 'vm-noimg' })))
    const api = createExeApi({ token: 't', exec })

    await api.createVm({ name: 'vm-noimg' })

    expect(calls).toEqual([['new', '--name', 'vm-noimg', '--json']])
  })

  it('omits `--image` when the image is an empty string (explicit "use exe default")', async () => {
    const { exec, calls } = fakeExec(() => ok(JSON.stringify({ vm_name: 'vm-empty' })))
    const api = createExeApi({ token: 't', exec })

    await api.createVm({ name: 'vm-empty', image: '' })

    expect(calls).toEqual([['new', '--name', 'vm-empty', '--json']])
  })

  it('derives `<vm_name>.exe.xyz` as the SSH host when the JSON omits ssh_dest, defaulting the port', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify({ vm_name: 'vm-derived' })))
    const api = createExeApi({ token: 't', exec })

    const vm = await api.createVm({ name: 'vm-derived' })

    expect(vm).toEqual({
      name: 'vm-derived',
      sshHost: 'vm-derived.exe.xyz',
      sshPort: 22,
      sshUser: 'exedev',
      ref: 'vm-derived',
    })
  })

  it('throws MachineProviderError when the lobby command exits non-zero', async () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stdout: '', stderr: 'quota exceeded' }))
    const api = createExeApi({ token: 't', exec })

    await expect(api.createVm({ name: 'n' })).rejects.toThrow(MachineProviderError)
    await expect(api.createVm({ name: 'n' })).rejects.toThrow(/quota exceeded/)
  })

  it('throws MachineProviderError on malformed (non-JSON) output', async () => {
    const { exec } = fakeExec(() => ok('not json at all'))
    const api = createExeApi({ token: 't', exec })

    await expect(api.createVm({ name: 'n' })).rejects.toThrow(MachineProviderError)
  })

  it('throws MachineProviderError when the JSON lacks a vm_name', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify({ ssh_dest: 'nameless.exe.xyz' })))
    const api = createExeApi({ token: 't', exec })

    await expect(api.createVm({ name: 'n' })).rejects.toThrow(MachineProviderError)
  })
})

describe('createExeApi.destroyVm', () => {
  it('runs `rm <ref>`', async () => {
    const { exec, calls } = fakeExec(() => ok(''))
    const api = createExeApi({ token: 't', exec })

    await api.destroyVm('vm-abc')

    expect(calls).toEqual([['rm', 'vm-abc']])
  })

  it('throws MachineProviderError when rm exits non-zero', async () => {
    const { exec } = fakeExec(() => ({ exitCode: 2, stdout: '', stderr: 'no such vm' }))
    const api = createExeApi({ token: 't', exec })

    await expect(api.destroyVm('gone')).rejects.toThrow(MachineProviderError)
  })
})

describe('createExeApi.getVm', () => {
  it('runs `ls --json` and returns the running state for the matching ref from the `.vms` array', async () => {
    const { exec, calls } = fakeExec(() =>
      ok(
        JSON.stringify({
          vms: [
            { vm_name: 'vm-abc', status: 'running' },
            { vm_name: 'vm-other', status: 'running' },
          ],
        })
      )
    )
    const api = createExeApi({ token: 't', exec })

    const vm = await api.getVm('vm-abc')

    expect(calls).toEqual([['ls', '--json']])
    expect(vm).toEqual({ state: 'running' })
  })

  it('maps a stopped VM to state "stopped"', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify({ vms: [{ vm_name: 'vm-abc', status: 'stopped' }] })))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).resolves.toEqual({ state: 'stopped' })
  })

  it('defaults to "running" when the entry omits a status field', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify({ vms: [{ vm_name: 'vm-abc' }] })))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).resolves.toEqual({ state: 'running' })
  })

  it('maps an unrecognized status to "gone" (fail-safe — never reports a broken VM as running)', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify({ vms: [{ vm_name: 'vm-abc', status: 'error' }] })))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).resolves.toEqual({ state: 'gone' })
  })

  it('returns null when the ref is absent from the listing (destroyed / gone)', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify({ vms: [{ vm_name: 'someone-else', status: 'running' }] })))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).resolves.toBeNull()
  })

  it('returns null for an empty `.vms` listing', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify({ vms: [] })))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).resolves.toBeNull()
  })

  it('throws MachineProviderError when `.vms` is not an array', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify({ vms: 'not-an-array' })))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).rejects.toThrow(MachineProviderError)
  })

  it('throws MachineProviderError when the response is a bare array (missing `.vms`)', async () => {
    const { exec } = fakeExec(() => ok(JSON.stringify([{ vm_name: 'vm-abc' }])))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).rejects.toThrow(MachineProviderError)
  })

  it('throws MachineProviderError when the listing is malformed', async () => {
    const { exec } = fakeExec(() => ok('{ not json'))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).rejects.toThrow(MachineProviderError)
  })

  it('throws MachineProviderError when the ls command exits non-zero', async () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stdout: '', stderr: 'auth failed' }))
    const api = createExeApi({ token: 't', exec })

    await expect(api.getVm('vm-abc')).rejects.toThrow(MachineProviderError)
  })
})

describe('createExeApi.cloneVm', () => {
  // cp/clone shape is UNVERIFIED (not recon'd 2026-07-13); this pins only that
  // cloneVm drives `cp <ref> <newName> --json` through the shared toExeVm parser.
  it('runs `cp <ref> <newName> --json` and parses the clone SSH endpoint', async () => {
    const { exec, calls } = fakeExec(() =>
      ok(JSON.stringify({ vm_name: 'vm-clone', ssh_dest: 'vm-clone.exe.xyz', ssh_port: 22 }))
    )
    const api = createExeApi({ token: 't', exec })

    const vm = await api.cloneVm!('vm-src', 'vm-clone')

    expect(calls).toEqual([['cp', 'vm-src', 'vm-clone', '--json']])
    expect(vm).toEqual({
      name: 'vm-clone',
      sshHost: 'vm-clone.exe.xyz',
      sshPort: 22,
      sshUser: 'exedev',
      ref: 'vm-clone',
    })
  })
})
