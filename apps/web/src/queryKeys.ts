// Query keys now live in @tau/client-core so web and mobile share one definition.
export { queryKeys } from '@tau/client-core'

export const modelTierQueryKeys = { list: () => ['model-tiers'] as const }

/**
 * Onboarding has no mobile surface yet, so its keys live here directly
 * instead of in the shared @tau/client-core definitions — same `all` +
 * per-query-shape convention as everything in queryKeys.
 */
export const onboardingQueryKeys = {
  all: ['onboarding'] as const,
  status: () => [...onboardingQueryKeys.all, 'status'] as const,
}

export const integrationQueryKeys = {
  outputs: () => ['integrations', 'outputs'] as const,
  all: ['integrations'] as const,
  catalog: () => [...integrationQueryKeys.all, 'catalog'] as const,
  pool: (provider: string) => [...integrationQueryKeys.all, 'pool', provider] as const,
  serviceSettings: (provider: string) => [...integrationQueryKeys.all, 'service-settings', provider] as const,
  deploymentSettings: (provider: string) => [...integrationQueryKeys.all, 'deployment-settings', provider] as const,
  channelSettings: (provider: string) => [...integrationQueryKeys.all, 'channel-settings', provider] as const,
  linearWebhook: () => [...integrationQueryKeys.all, 'webhook', 'linear'] as const,
  squadGitAuthorDefaults: (squadId: string) =>
    [...integrationQueryKeys.all, 'squad', squadId, 'github', 'author-defaults'] as const,
  gitAuthorDefaults: () => [...integrationQueryKeys.all, 'git-author-defaults'] as const,
  githubWebhook: () => [...integrationQueryKeys.all, 'webhook', 'github'] as const,
  oauthApp: (provider: string) => [...integrationQueryKeys.all, 'oauth-app', provider] as const,
  squad: (squadId: string, provider: string) => [...integrationQueryKeys.all, 'squad', squadId, provider] as const,
  export: (agentId: string) => [...integrationQueryKeys.all, 'export', agentId] as const,
}

export const modelCatalogQueryKeys = {
  all: ['model-catalog'] as const,
  list: (agentId?: string) => ['model-catalog', agentId ?? 'settings'] as const,
}

export const assistantQueryKeys = {
  editor: (id: string) => ['assistant', 'editor', id] as const,
  all: ['assistant-conversations'] as const,
  list: (q = '', offset = 0) => ['assistant-conversations', 'list', q, offset] as const,
  history: (id: string) => ['assistant-conversations', 'history', id] as const,
}

export const feedQueryKeys = {
  visit: (userId: string) => ['auth', 'feed-visit', userId] as const,
  completed: (after: string, before: string) => ['squads', 'feed-completed', after, before, 'items'] as const,
  recent: (after: string, squads: readonly string[]) => ['squads', 'feed-recent', after, [...squads].sort()] as const,
}

export const channelLinkQueryKeys = { all: ['channel-links'] as const }
