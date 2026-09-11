import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPut } from '../client'
import { setOutputOptions } from '../output'
import { registerAgentTypeCommands } from './agent-type'

const existing = {
  id: 'engineer',
  name: 'Engineer',
  model: '',
  description: 'Writes code',
  systemPrompt: 'You implement.',
  includes: ['rules', 'subagents', 'squad-rules'],
  skills: ['test-driven-development'],
  extensions: null,
  toolsAllow: null,
  toolsDeny: null,
}

describe('tau agent-type update', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(existing)
    ;(apiPut as ReturnType<typeof mock>).mockClear()
    ;(apiPut as ReturnType<typeof mock>).mockResolvedValue(existing)
  })

  afterEach(() => {
    mock.restore()
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    program.option('--json')
    program.option('--quiet')
    program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
    registerAgentTypeCommands(program)
    await program.parseAsync(['--quiet', ...args], { from: 'user' })
  }

  // The PUT replaces the whole row, so a rebuilt body that drops `includes`
  // would strip the type's shared prompt blocks on any unrelated edit.
  it('carries the existing include list into the update body', async () => {
    await run(['agent-type', 'update', 'engineer', '--description', 'Writes better code'])

    expect(apiPut).toHaveBeenCalledWith(
      '/api/agent-types/engineer',
      expect.objectContaining({
        description: 'Writes better code',
        includes: ['rules', 'subagents', 'squad-rules'],
      })
    )
  })

  it('sends an empty list for a type that has no includes', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue({ ...existing, includes: null })

    await run(['agent-type', 'update', 'engineer', '--name', 'Engineer II'])

    expect(apiPut).toHaveBeenCalledWith('/api/agent-types/engineer', expect.objectContaining({ includes: [] }))
  })
})
