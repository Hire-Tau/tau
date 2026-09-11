import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Command } from 'commander'
import { apiDelete, apiGet, apiPost, apiPut } from '../client'
import { setOutputOptions } from '../output'
import { readCredentialFromStdin, registerIntegrationCommands } from './integration'

type AnyMock = ReturnType<typeof mock>

async function run(args: string[], credential = 'stdin-secret'): Promise<void> {
  const program = new Command().exitOverride()
  program.option('--quiet')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerIntegrationCommands(program, { readCredential: async () => credential })
  await program.parseAsync(['--quiet', ...args], { from: 'user' })
}

beforeEach(() => {
  for (const fn of [apiGet, apiPost, apiPut, apiDelete] as AnyMock[]) {
    fn.mockClear()
    fn.mockResolvedValue({})
  }
})

test('help permits credentials only through stdin and requires explicit export consent', () => {
  const program = new Command().exitOverride()
  registerIntegrationCommands(program)
  const integration = program.commands.find((command) => command.name() === 'integration')!
  const create = integration.commands.find((command) => command.name() === 'create')!.helpInformation()
  expect(create).toContain('--credential-stdin')
  expect(create).not.toContain('--squad')
  expect(create).not.toContain('--token')
  expect(create).not.toContain('--credential <')
  const enable = integration.commands.find((command) => command.name() === 'export-enable')!.helpInformation()
  expect(enable).toContain('--consent')
})

describe('global connection lifecycle paths', () => {
  test('list is provider-filtered and get is global', async () => {
    await run(['integration', 'list', '--provider', 'bigbrain'])
    expect(apiGet).toHaveBeenCalledWith('/api/integrations/connections?provider=bigbrain')
    await run(['integration', 'get', 'connection-1'])
    expect(apiGet).toHaveBeenCalledWith('/api/integrations/connections/connection-1')
  })

  test('create and credential rotation use global paths with stdin-only values', async () => {
    await run(
      ['integration', 'create', 'bigbrain', '--api-base', 'https://brain.example', '--credential-stdin'],
      'create-secret'
    )
    expect(apiPost).toHaveBeenCalledWith('/api/integrations/connections', {
      provider: 'bigbrain',
      displayName: 'Bigbrain',
      configuration: { version: 1, apiBase: 'https://brain.example' },
      credential: 'create-secret',
    })

    await run(
      ['integration', 'credential', 'connection-1', '--credential-stdin', '--confirm-assigned'],
      'rotate-secret'
    )
    expect(apiPut).toHaveBeenCalledWith('/api/integrations/connections/connection-1/credential', {
      credential: 'rotate-secret',
      confirmAssigned: true,
    })
  })

  test.each(['validate', 'enable'] as const)('%s uses the global lifecycle route', async (action) => {
    await run(['integration', action, 'connection-1'])
    expect(apiPost).toHaveBeenCalledWith(`/api/integrations/connections/connection-1/${action}`, {})
  })

  test('used disable and removal require an explicit confirmation flag', async () => {
    await run(['integration', 'disable', 'connection-1', '--confirm-assigned'])
    expect(apiPost).toHaveBeenCalledWith('/api/integrations/connections/connection-1/disable', {
      confirmAssigned: true,
    })
    await run(['integration', 'remove', 'connection-1', '--confirm-assigned'])
    expect(apiDelete).toHaveBeenCalledWith('/api/integrations/connections/connection-1?confirmAssigned=true')
  })
})

test('stdin credential reader enforces a bounded payload and trims only trailing line endings', async () => {
  const bytes = (value: string) => new TextEncoder().encode(value)
  async function* stream(...chunks: Uint8Array[]) {
    yield* chunks
  }

  await expect(readCredentialFromStdin(stream(bytes('secret'), bytes('\r\n')))).resolves.toBe('secret')
  await expect(readCredentialFromStdin(stream(new Uint8Array(16 * 1024)))).resolves.toHaveLength(16 * 1024)
  await expect(readCredentialFromStdin(stream(new Uint8Array(16 * 1024 + 1)))).rejects.toThrow(
    'Credential exceeds maximum length'
  )
})

test('assign and unassign use explicit squad assignment routes', async () => {
  await run([
    'integration',
    'assign',
    'bigbrain',
    '--squad',
    'squad-1',
    '--connection',
    '00000000-0000-4000-8000-000000000001',
  ])
  expect(apiPut).toHaveBeenCalledWith('/api/squads/squad-1/integrations/bigbrain/assignment', {
    connectionId: '00000000-0000-4000-8000-000000000001',
  })
  await run(['integration', 'unassign', 'bigbrain', '--squad', 'squad-1'])
  expect(apiDelete).toHaveBeenCalledWith('/api/squads/squad-1/integrations/bigbrain/assignment')
})

test('outputs lists the provider event catalog', async () => {
  await run(['integration', 'outputs'])
  expect(apiGet).toHaveBeenCalledWith('/api/integrations/outputs')
})
