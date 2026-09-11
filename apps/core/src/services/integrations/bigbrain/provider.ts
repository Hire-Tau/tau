import { z } from 'zod'
import type { IntegrationProvider, ProviderValidation } from '../types'
import { BigbrainClient, validateBaseUrl } from './client'
import { BigbrainError } from './errors'

export interface BigbrainConfigV1 {
  version: 1
  apiBase: string
}

const ConfigSchema = z.object({ version: z.literal(1), apiBase: z.string().max(2_048) }).strict()

export class BigbrainProvider implements IntegrationProvider<BigbrainConfigV1> {
  readonly key = 'bigbrain'
  readonly adapterVersion = 1
  readonly capabilities = {}
  readonly #fetch: import('./client').BigbrainFetch

  constructor(options: { fetch?: import('./client').BigbrainFetch } = {}) {
    this.#fetch = options.fetch ?? fetch
  }

  parseConfig(value: unknown): BigbrainConfigV1 {
    const config = ConfigSchema.parse(value)
    validateBaseUrl(config.apiBase)
    return config
  }

  async validate(
    context: Parameters<IntegrationProvider<BigbrainConfigV1>['validate']>[0]
  ): Promise<ProviderValidation> {
    try {
      const result = await new BigbrainClient({
        apiBase: context.connection.configuration.apiBase,
        credential: () => context.credential,
        fetch: this.#fetch,
      }).validate()
      const scopes = parseScopes(result)
      return { ok: true, grantedScopes: scopes }
    } catch (error) {
      if (error instanceof BigbrainError) return { ok: false, code: error.code }
      return { ok: false, code: 'provider_error' }
    }
  }
}

function parseScopes(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { scopes?: unknown }).scopes)) return []
  return [
    ...new Set(
      (value as { scopes: unknown[] }).scopes.filter(
        (scope): scope is string => typeof scope === 'string' && scope.length <= 100
      )
    ),
  ]
}
