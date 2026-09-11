import { BigbrainError } from './errors'
import { encodeBigbrainSession, sendBigbrainSession } from './export'
import { BigbrainProvider, type BigbrainConfigV1 } from './provider'
import { createBigbrainTools, type BigbrainTool, type BigbrainToolContext } from './tools'
import type { IntegrationPluginV1 } from '../plugin'

const provider = new BigbrainProvider()

const plugin: IntegrationPluginV1<
  BigbrainConfigV1,
  string,
  { createTools(context: BigbrainToolContext): readonly BigbrainTool[] }
> = {
  manifestVersion: 1,
  key: 'bigbrain',
  adapterVersion: 1,
  presentation: {
    label: 'Bigbrain',
    description: 'Connect a Bigbrain vault for agent tools and conversation export.',
    icon: 'bigbrain',
    connectionMode: 'credential',
    assignable: true,
    requiredCapabilities: ['agent_tools', 'conversation_export'],
  },
  connection: {
    parseConfiguration: (input) => provider.parseConfig(input),
    safeConfiguration: (configuration) => ({ version: configuration.version, apiBase: configuration.apiBase }),
    credential: {
      parse(value) {
        if (typeof value !== 'string' || value.length < 1 || value.length > 16_384)
          throw new Error('Invalid credential')
        return value
      },
      serialize(value) {
        return this.parse(value)
      },
    },
  },
  authorization: { kind: 'manual' },
  runtime: {
    provider,
    agentTools: { createTools: createBigbrainTools },
    conversationExport: { encode: encodeBigbrainSession, send: sendBigbrainSession },
  },
  sandbox: {
    packages: [],
    setupSteps: [],
    initHooks: [],
    readiness: [],
    skills: [],
    extensions: [],
    protectedBindings: [],
  },
  lifecycle: { refresh: false, revoke: false },
  classifyError(error) {
    if (error instanceof BigbrainError) {
      return {
        code: error.code,
        retryable: !['invalid_auth', 'missing_scope', 'invalid_configuration'].includes(error.code),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      }
    }
    return { code: 'provider_error', retryable: true }
  },
}

export const bigbrainPlugin = Object.freeze(plugin)

export { encodeBigbrainSession }
