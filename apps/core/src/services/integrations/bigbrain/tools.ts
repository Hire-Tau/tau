import { Type } from '@sinclair/typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { IntegrationRuntimeGate, RuntimeGateAgent } from '../runtime-gate'
import type { IntegrationCredentialStore } from '../connection-repository'
import type { IntegrationAuditRecorder } from '../audit'
import { BigbrainClient } from './client'
import { BigbrainError } from './errors'
import type { BigbrainConfigV1 } from './provider'

export const BIGBRAIN_TOOL_NAMES = [
  'bigbrain_search',
  'bigbrain_get_note',
  'bigbrain_get_memory',
  'bigbrain_drop_markdown',
] as const
export type BigbrainTool = ToolDefinition & { key: string }

export interface BigbrainToolContext {
  agent: RuntimeGateAgent
  squadId: string
  gate: IntegrationRuntimeGate
  credentials: IntegrationCredentialStore
  connections: Pick<import('../connection-repository').IntegrationConnectionRepository, 'disableRuntimeAuthFailure'>
  audit: IntegrationAuditRecorder
  fetch?: import('./client').BigbrainFetch
}

export function createBigbrainTools(context: BigbrainToolContext): BigbrainTool[] {
  return [
    tool(
      'bigbrain_search',
      'Search Bigbrain vault',
      Type.Object({
        query: Type.String({ minLength: 1, maxLength: 1_000 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      'vault:read',
      async (client, input: { query: string; limit?: number }) => client.search(input.query, input.limit)
    ),
    tool(
      'bigbrain_get_note',
      'Retrieve a Bigbrain Markdown note',
      Type.Object({
        path: Type.String({ minLength: 3, maxLength: 1_000, pattern: '^[^/\\\\](?!.*(?:^|/)\\.\\.(?:/|$)).*\\.md$' }),
      }),
      'vault:read',
      async (client, input: { path: string }) => client.getNote(input.path)
    ),
    tool(
      'bigbrain_get_memory',
      'Retrieve Bigbrain memory index content',
      Type.Object({ path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })) }),
      'vault:read',
      async (client, input: { path?: string }) => client.getMemory(input.path)
    ),
    tool(
      'bigbrain_drop_markdown',
      'Write Markdown to the Bigbrain inbox',
      Type.Object({
        markdown: Type.String({ minLength: 1, maxLength: 262_144 }),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        poke: Type.Optional(Type.Boolean()),
      }),
      'inbox:write',
      async (client, input: { markdown: string; name?: string; poke?: boolean }) =>
        client.dropMarkdown(input.markdown, { name: input.name, poke: input.poke })
    ),
  ]

  function tool<T>(
    name: (typeof BIGBRAIN_TOOL_NAMES)[number],
    description: string,
    parameters: ToolDefinition['parameters'],
    requiredScope: string,
    invoke: (client: BigbrainClient, input: T) => Promise<unknown>
  ): BigbrainTool {
    return {
      key: name,
      name,
      label: description,
      description,
      parameters,
      async execute(_toolCallId: string, input: T): Promise<AgentToolResult<unknown>> {
        const decision = await context.gate.check({
          agent: context.agent,
          squadId: context.squadId,
          provider: 'bigbrain',
          capability: 'agent_tools',
          requiredScope,
        })
        if (!decision.allowed) return failure('integration_unavailable')
        const credential = context.credentials.get(decision.connection.credentialRef)
        if (!credential) return failure('credential_unavailable')
        try {
          const configuration = decision.connection.configuration as BigbrainConfigV1
          const result = await invoke(
            new BigbrainClient({ apiBase: configuration.apiBase, credential: () => credential, fetch: context.fetch }),
            input
          )
          await context.audit.record({
            squadId: context.squadId,
            agentId: context.agent.id,
            connectionId: decision.connection.id,
            capability: 'agent_tools',
            action: name,
            outcome: 'succeeded',
            at: new Date(),
          })
          const safe = { provider: 'bigbrain', connectionId: decision.connection.id, result }
          return { content: [{ type: 'text', text: JSON.stringify(safe) }], details: safe }
        } catch (error) {
          const code = error instanceof BigbrainError ? error.code : 'provider_error'
          if (code === 'invalid_auth') {
            await context.connections.disableRuntimeAuthFailure({
              id: decision.connection.id,
              materialRevision: decision.connection.materialRevision,
            })
          }
          await context.audit.record({
            squadId: context.squadId,
            agentId: context.agent.id,
            connectionId: decision.connection.id,
            capability: 'agent_tools',
            action: name,
            outcome: 'failed',
            code,
            at: new Date(),
          })
          return failure(code)
        }
      },
    }
  }
}

function failure(code: string): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: `Bigbrain request unavailable (${code})` }],
    details: { success: false, code },
  }
}
