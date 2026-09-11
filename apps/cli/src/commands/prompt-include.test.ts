import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPost, apiPut } from '../client'
import { output, outputTable, setOutputOptions } from '../output'
import { registerPromptIncludeCommands } from './prompt-include'

const includes = [
  { id: 'rules', name: 'Rules', description: null, disabled: false, yamlFieldOverrides: null },
  { id: 'subagents', name: 'Subagents', description: null, disabled: true, yamlFieldOverrides: { name: 'Custom' } },
]

const tempDirs: string[] = []

async function makeTempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tau-prompt-include-test-'))
  tempDirs.push(dir)
  const file = join(dir, 'content.md')
  await writeFile(file, content, 'utf-8')
  return file
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  program.option('--json')
  program.option('--quiet')
  program.hook('preAction', (command) => setOutputOptions(command.optsWithGlobals()))
  registerPromptIncludeCommands(program)
  await program.parseAsync(['--quiet', ...args], { from: 'user' })
}

describe('tau prompt-include', () => {
  beforeEach(() => {
    ;(apiGet as ReturnType<typeof mock>).mockClear().mockResolvedValue(includes)
    ;(apiPut as ReturnType<typeof mock>).mockClear().mockResolvedValue({ id: 'rules' })
    ;(apiPost as ReturnType<typeof mock>).mockClear().mockResolvedValue({ id: 'rules' })
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputTable as ReturnType<typeof mock>).mockClear()
  })

  afterEach(async () => {
    mock.restore()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('list fetches all prompt includes and prints their ids', async () => {
    await run(['prompt-include', 'list'])

    expect(apiGet).toHaveBeenCalledWith('/api/prompt-includes')
    // outputTable is mocked, so assert on the mock call args directly to
    // confirm the printed rows actually contain both ids.
    const rows = (outputTable as ReturnType<typeof mock>).mock.calls.at(-1)?.[0]
    expect(rows.map((r: any) => r.id)).toEqual(['rules', 'subagents'])
  })

  it('get fetches one prompt include by id', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(includes[0])

    await run(['prompt-include', 'get', 'rules'])

    expect(apiGet).toHaveBeenCalledWith('/api/prompt-includes/rules')
    expect(output).toHaveBeenCalledWith(includes[0])
  })

  it('update reads the file and PUTs its content', async () => {
    const file = await makeTempFile('New shared block content')

    await run(['prompt-include', 'update', 'rules', '--file', file])

    expect(apiPut).toHaveBeenCalledWith('/api/prompt-includes/rules', { content: 'New shared block content' })
  })

  it('update requires --file', async () => {
    await expect(run(['prompt-include', 'update', 'rules'])).rejects.toThrow()
  })

  it('disable posts to the disable endpoint', async () => {
    await run(['prompt-include', 'disable', 'rules'])

    expect(apiPost).toHaveBeenCalledWith('/api/prompt-includes/rules/disable')
  })

  it('enable posts to the enable endpoint', async () => {
    await run(['prompt-include', 'enable', 'rules'])

    expect(apiPost).toHaveBeenCalledWith('/api/prompt-includes/rules/enable')
  })
})
