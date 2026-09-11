import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet } from '../client'
import { outputTable, setOutputOptions } from '../output'
import { registerSquadEnvCommands } from './squad-env'

describe('squad-env CLI commands', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(outputTable as ReturnType<typeof mock>).mockClear()
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerSquadEnvCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  it('prints the effective exposed field from the API response for squad secrets', async () => {
    const secrets = [
      {
        key: 'DEPLOY_VERCEL_TOKEN',
        isSet: true,
        exposed: true,
        squadExposed: false,
        globallyExposed: true,
      },
      {
        key: 'DEPLOY_NETLIFY_TOKEN',
        isSet: true,
        exposed: false,
        squadExposed: false,
        globallyExposed: false,
      },
    ]
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ secrets })

    await run(['squad-env', 'secrets', 'squad-1'])

    expect(apiGet).toHaveBeenCalledWith('/api/squads/workspace/squad-1/env/secrets')
    expect(outputTable).toHaveBeenCalledWith(secrets, ['key', 'isSet', 'exposed'])
  })
})
