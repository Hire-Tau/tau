import { Command } from 'commander'
import { apiDelete, apiGet, apiPost } from '../client'
import { output, outputError, outputTable, isJsonMode } from '../output'

interface GrantInput {
  granteeSquadId: string
  policy: unknown
  expiresAt?: string | null
}

function printGrants(grants: Array<Record<string, unknown>>, columns: string[]): void {
  if (isJsonMode()) {
    output(grants)
    return
  }

  if (grants.length === 0) {
    console.log('No grants found')
    return
  }

  outputTable(grants, columns)
}

export function registerSquadGrantCommands(parent: Command): void {
  const grant = parent.command('grant').description('Manage cross-squad memory grants')

  grant
    .command('create <sourceSquadId>')
    .description('Create a memory grant from a source squad to a grantee squad')
    .requiredOption('--to <granteeSquadId>', 'grantee squad ID')
    .requiredOption('--policy <json>', 'grant policy as JSON, e.g. \'{"read":{"sourceTypes":["memory_file"]}}\'')
    .option('--expires <iso>', 'optional expiration timestamp (ISO 8601)')
    .action(async (sourceSquadId: string, opts: { to: string; policy: string; expires?: string }) => {
      try {
        const body: GrantInput = {
          granteeSquadId: opts.to,
          policy: JSON.parse(opts.policy),
          expiresAt: opts.expires ?? null,
        }
        const created = await apiPost(`/api/squads/${sourceSquadId}/grants`, body)
        output(created)
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  grant
    .command('list <sourceSquadId>')
    .description('List grants issued by a squad')
    .action(async (sourceSquadId: string) => {
      try {
        const grants = await apiGet<Array<Record<string, unknown>>>(`/api/squads/${sourceSquadId}/grants`)
        printGrants(grants, ['id', 'granteeSquadId', 'expiresAt'])
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  grant
    .command('received <granteeSquadId>')
    .alias('granted')
    .description('List grants received by a squad')
    .action(async (granteeSquadId: string) => {
      try {
        const grants = await apiGet<Array<Record<string, unknown>>>(`/api/squads/${granteeSquadId}/granted`)
        printGrants(grants, ['id', 'sourceSquadId', 'expiresAt'])
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })

  grant
    .command('delete <grantId>')
    .description('Delete a memory grant')
    .action(async (grantId: string) => {
      try {
        await apiDelete(`/api/grants/${grantId}`)
        output({ deleted: grantId })
      } catch (error) {
        outputError(error as Error)
        process.exit(1)
      }
    })
}
