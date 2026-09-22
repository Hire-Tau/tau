import { createProvider, hasApi, type Model, type Api, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { Account } from './account-store'

// The upstream OpenAI transport requires a nonempty SDK key even for an
// explicitly keyless server. Keep this adapter-only value off the wire and
// out of stored credentials; a missing account is still unconfigured.
function requestOptions<T extends SimpleStreamOptions>(options: T | undefined): T | SimpleStreamOptions {
  return options?.apiKey
    ? options
    : { ...options, apiKey: 'unused', headers: { ...options?.headers, Authorization: null } }
}

function compatibleModel(model: Model<Api>) {
  if (!hasApi(model, 'openai-completions')) throw new Error('Compatible provider requires the OpenAI completions API')
  return model
}

export function compatibleRuntimeProvider(providerId: string, account: Account) {
  return createProvider({
    id: providerId,
    name: `OpenAI Compatible: ${account.label || providerId}`,
    auth: {
      apiKey: {
        name: 'API key (optional)',
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted()
          if (!credential) return undefined
          return {
            source: 'stored compatible account',
            auth: credential.key ? { apiKey: credential.key } : { headers: { Authorization: null } },
            env: credential.env,
          }
        },
      },
    },
    api: {
      stream: (model, context, options) => stream(compatibleModel(model), context, requestOptions(options)),
      streamSimple: (model, context, options) => streamSimple(compatibleModel(model), context, requestOptions(options)),
    },
    models: [
      {
        id: account.model!,
        provider: providerId,
        name: account.label || account.model!,
        api: 'openai-completions',
        baseUrl: account.baseUrl!,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: account.capabilities?.contextWindow ?? 32768,
        maxTokens: 8192,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
    ],
  })
}
