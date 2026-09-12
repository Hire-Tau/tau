import { readFile } from 'fs/promises'
import type { Command } from 'commander'
import { apiGet, apiPost, apiPut } from '../client'
import { isJsonMode, output, outputError, outputTable } from '../output'

interface SharedPrompt {
  id: string
  name: string
  description: string | null
  content: string
  /** Names of fields that drifted from the YAML template, empty when in sync. */
  yamlFieldOverrides: string[] | null
  hasTemplate: boolean
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export function registerSharedPromptCommands(program: Command) {
  const sharedPrompt = program
    .command('shared-prompt')
    .alias('shared-prompts')
    .description('Manage shared prompts included by agent types')

  sharedPrompt
    .command('list')
    .description('List shared prompts')
    .action(async () => {
      try {
        const includes = await apiGet<SharedPrompt[]>('/api/shared-prompts')
        if (isJsonMode()) return output(includes)
        outputTable(
          includes.map((i) => ({
            id: i.id,
            name: i.name,
            disabled: i.disabled ? 'yes' : 'no',
            overridden: (i.yamlFieldOverrides ?? []).length > 0 ? 'yes' : 'no',
          })),
          ['id', 'name', 'disabled', 'overridden']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  sharedPrompt
    .command('get <id>')
    .alias('info')
    .description('Get shared prompt details')
    .action(async (id) => {
      try {
        output(await apiGet<SharedPrompt>(`/api/shared-prompts/${id}`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  sharedPrompt
    .command('update <id>')
    .description('Update a shared prompt content')
    .requiredOption('--file <path>', 'Read new content from file')
    .action(async (id, options) => {
      try {
        const content = await readFile(options.file, 'utf-8')
        const result = await apiPut(`/api/shared-prompts/${id}`, { content })
        output(result)
      } catch (error) {
        outputError(error as Error)
      }
    })

  sharedPrompt
    .command('disable <id>')
    .description('Disable a shared prompt')
    .action(async (id) => {
      try {
        await apiPost(`/api/shared-prompts/${id}/disable`)
        output({ id, disabled: true }, `Disabled shared prompt "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  sharedPrompt
    .command('enable <id>')
    .description('Enable a shared prompt')
    .action(async (id) => {
      try {
        await apiPost(`/api/shared-prompts/${id}/enable`)
        output({ id, enabled: true }, `Enabled shared prompt "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
