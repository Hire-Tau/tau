import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { configureGlobalOptionScope } from './global-options'
import { registerWorkstreamFlowCommands } from './commands/workstream-flow'

test('finish consumes its version while globals work before or after nested commands', async () => {
  for (const flags of ['before', 'after']) {
    const calls: unknown[] = []
    let globals: unknown
    const program = new Command()
      .exitOverride()
      .version('CLI-build')
      .option('--json')
      .option('--quiet')
      .option('--backend <label>')
    program.hook('preAction', (_root, action) => {
      globals = action.optsWithGlobals()
    })
    registerWorkstreamFlowCommands(program.command('workstream').alias('ws'), {
      apiGet: async () => null,
      apiPost: async (path, body) => {
        calls.push({ path, body })
        return { status: 'done' }
      },
      output: () => {},
      outputError: (error) => {
        throw error
      },
    })
    configureGlobalOptionScope(program)
    const globalArgs = ['--json', '--quiet', '--backend', 'smoke']
    const commandArgs = ['ws', 'finish', 'stream-id', '--version', '3']
    await program.parseAsync(flags === 'before' ? [...globalArgs, ...commandArgs] : [...commandArgs, ...globalArgs], {
      from: 'user',
    })
    expect(calls).toEqual([{ path: '/api/workflows/runs/stream-id/finish', body: { version: 3 } }])
    expect(globals).toMatchObject({ json: true, quiet: true, backend: 'smoke' })
  }
})

test('top-level version still prints the CLI version', () => {
  let printed = ''
  const program = new Command()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        printed += text
      },
    })
    .version('CLI-build')
  configureGlobalOptionScope(program)
  expect(() => program.parse(['--version'], { from: 'user' })).toThrow()
  expect(printed).toBe('CLI-build\n')
})
