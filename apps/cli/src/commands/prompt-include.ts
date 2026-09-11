import { readFile } from 'fs/promises'
import type { Command } from 'commander'
import { apiGet, apiPost, apiPut } from '../client'
import { isJsonMode, output, outputError, outputTable } from '../output'

interface PromptInclude {
  id: string
  name: string
  description: string | null
  content: string
  yamlFieldOverrides: Record<string, unknown> | null
  hasTemplate: boolean
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export function registerPromptIncludeCommands(program: Command) {
  const promptInclude = program
    .command('prompt-include')
    .alias('prompt-includes')
    .description('Manage shared prompt blocks included by agent types')

  promptInclude
    .command('list')
    .description('List prompt includes')
    .action(async () => {
      try {
        const includes = await apiGet<PromptInclude[]>('/api/prompt-includes')
        if (isJsonMode()) return output(includes)
        outputTable(
          includes.map((i) => ({
            id: i.id,
            name: i.name,
            disabled: i.disabled ? 'yes' : 'no',
            overridden: i.yamlFieldOverrides && Object.keys(i.yamlFieldOverrides).length > 0 ? 'yes' : 'no',
          })),
          ['id', 'name', 'disabled', 'overridden']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  promptInclude
    .command('get <id>')
    .alias('info')
    .description('Get prompt include details')
    .action(async (id) => {
      try {
        output(await apiGet<PromptInclude>(`/api/prompt-includes/${id}`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  promptInclude
    .command('update <id>')
    .description('Update a prompt include content')
    .requiredOption('--file <path>', 'Read new content from file')
    .action(async (id, options) => {
      try {
        const content = await readFile(options.file, 'utf-8')
        const result = await apiPut(`/api/prompt-includes/${id}`, { content })
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  promptInclude
    .command('disable <id>')
    .description('Disable a prompt include')
    .action(async (id) => {
      try {
        const result = await apiPost(`/api/prompt-includes/${id}/disable`)
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  promptInclude
    .command('enable <id>')
    .description('Enable a prompt include')
    .action(async (id) => {
      try {
        const result = await apiPost(`/api/prompt-includes/${id}/enable`)
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
