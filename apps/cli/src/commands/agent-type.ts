import { readFile } from 'fs/promises'
import { Command } from 'commander'
import { apiGet, apiPost, apiPut, apiDelete, apiGetRaw } from '../client'
import { output, outputTable, outputError } from '../output'

interface AgentType {
  id: string
  name: string
  model: string
  description: string | null
  systemPrompt: string
  skills: string[] | null
  extensions: string[] | null
  toolsAllow: string[] | null
  toolsDeny: string[] | null
}

function csvToArray(csv?: string): string[] | undefined {
  return csv
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function systemPromptFromOptions(options: {
  systemPrompt?: string
  systemPromptFile?: string
}): Promise<string | undefined> {
  if (options.systemPrompt !== undefined) return options.systemPrompt
  if (options.systemPromptFile) return readFile(options.systemPromptFile, 'utf-8')
  return undefined
}

function applyArrayOption(body: Record<string, unknown>, key: string, value?: string): void {
  if (value !== undefined) body[key] = csvToArray(value) ?? []
}

export function registerAgentTypeCommands(program: Command) {
  const agentType = program.command('agent-type').alias('at').description('View and manage agent type definitions')

  agentType
    .command('list')
    .description('List all agent types')
    .action(async () => {
      try {
        const types = await apiGet<AgentType[]>('/api/agent-types')
        outputTable(
          types.map((t) => ({ id: t.id, name: t.name, model: t.model, description: t.description ?? '' })),
          ['id', 'name', 'model', 'description']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('get <id>')
    .alias('info')
    .description('Get agent type details')
    .action(async (id) => {
      try {
        output(await apiGet<AgentType>(`/api/agent-types/${id}`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('create')
    .description('Create a new agent type')
    .requiredOption('--id <id>', 'Agent type ID')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--model <model>', 'Model spec, e.g. openai/gpt-4.1, or a comma-separated priority list of specs')
    .option('--description <desc>', 'Description')
    .option('--system-prompt <prompt>', 'System prompt')
    .option('--system-prompt-file <path>', 'Read system prompt from file')
    .option('--skills <ids>', 'Skill IDs (comma-separated)')
    .option('--extensions <ids>', 'Extension IDs/paths (comma-separated)')
    .option('--tools-allow <tools>', 'Allowed tools (comma-separated)')
    .option('--tools-deny <tools>', 'Denied tools (comma-separated)')
    .action(async (options) => {
      try {
        const systemPrompt = await systemPromptFromOptions(options)
        if (!systemPrompt) throw new Error('System prompt is required (--system-prompt or --system-prompt-file)')
        const body: Record<string, unknown> = {
          id: options.id,
          name: options.name,
          model: options.model,
          systemPrompt,
        }
        if (options.description !== undefined) body.description = options.description
        applyArrayOption(body, 'skills', options.skills)
        applyArrayOption(body, 'extensions', options.extensions)
        applyArrayOption(body, 'toolsAllow', options.toolsAllow)
        applyArrayOption(body, 'toolsDeny', options.toolsDeny)

        const result = await apiPost<any>('/api/agent-types', body)
        output(result, `Created agent type "${options.id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('update <id>')
    .description('Update an agent type')
    .option('--name <name>', 'New name')
    .option('--model <model>', 'New model spec (single spec or comma-separated priority list of specs)')
    .option('--description <desc>', 'New description')
    .option('--system-prompt <prompt>', 'New system prompt')
    .option('--system-prompt-file <path>', 'Read new system prompt from file')
    .option('--skills <ids>', 'Replace skill IDs (comma-separated; pass empty string to clear)')
    .option('--add-skill <id>', 'Add one skill without replacing existing skills')
    .option('--remove-skill <id>', 'Remove one skill without replacing existing skills')
    .option('--extensions <ids>', 'Replace extension IDs/paths (comma-separated; pass empty string to clear)')
    .option('--tools-allow <tools>', 'Replace allowed tools (comma-separated; pass empty string to clear)')
    .option('--tools-deny <tools>', 'Replace denied tools (comma-separated; pass empty string to clear)')
    .action(async (id, options) => {
      try {
        if (options.addSkill && options.removeSkill) throw new Error('Use only one of --add-skill or --remove-skill')
        if (options.addSkill) {
          const result = await apiPost<any>(`/api/agent-types/${id}/add-skill`, { skillId: options.addSkill })
          output(result, `Added skill "${options.addSkill}" to agent type "${id}"`)
          return
        }
        if (options.removeSkill) {
          const result = await apiPost<any>(`/api/agent-types/${id}/remove-skill`, { skillId: options.removeSkill })
          output(result, `Removed skill "${options.removeSkill}" from agent type "${id}"`)
          return
        }
        const existing = await apiGet<AgentType>(`/api/agent-types/${id}`)
        const systemPrompt = await systemPromptFromOptions(options)
        const body: Record<string, unknown> = {
          name: options.name ?? existing.name,
          model: options.model ?? existing.model,
          description: options.description ?? existing.description,
          systemPrompt: systemPrompt ?? existing.systemPrompt,
          skills: existing.skills,
          extensions: existing.extensions,
          toolsAllow: existing.toolsAllow,
          toolsDeny: existing.toolsDeny,
        }
        applyArrayOption(body, 'skills', options.skills)
        applyArrayOption(body, 'extensions', options.extensions)
        applyArrayOption(body, 'toolsAllow', options.toolsAllow)
        applyArrayOption(body, 'toolsDeny', options.toolsDeny)

        const result = await apiPut<any>(`/api/agent-types/${id}`, body)
        output(result, `Updated agent type "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('delete <id>')
    .alias('rm')
    .description('Delete an agent type')
    .action(async (id) => {
      try {
        await apiDelete(`/api/agent-types/${id}`)
        output({ id, deleted: true }, `Deleted agent type "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('template-diff <id>')
    .description('Show diff between current config and YAML template')
    .action(async (id) => {
      try {
        output(await apiGet<any>(`/api/agent-types/${id}/template-diff`))
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('revert <id>')
    .description('Revert agent type to its YAML template')
    .action(async (id) => {
      try {
        await apiPost(`/api/agent-types/${id}/revert-to-template`)
        output({ id, reverted: true }, `Reverted agent type "${id}" to template`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('disable <id>')
    .description('Disable an agent type')
    .action(async (id) => {
      try {
        await apiPost(`/api/agent-types/${id}/disable`)
        output({ id, disabled: true }, `Disabled agent type "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('enable <id>')
    .description('Enable an agent type')
    .action(async (id) => {
      try {
        await apiPost(`/api/agent-types/${id}/enable`)
        output({ id, enabled: true }, `Enabled agent type "${id}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  agentType
    .command('export <id>')
    .description('Export agent type as YAML')
    .action(async (id) => {
      try {
        console.log(await (await apiGetRaw(`/api/agent-types/${id}/export`)).text())
      } catch (error) {
        outputError(error as Error)
      }
    })
}
