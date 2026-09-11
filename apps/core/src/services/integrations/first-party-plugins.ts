import { linearPlugin } from './linear/plugin'
import type { IntegrationPluginV1 } from './plugin'
import { bigbrainPlugin } from './bigbrain/plugin'
import { notionPlugin } from './notion/plugin'
import { githubPlugin } from './github/plugin'

export const firstPartyIntegrationPlugins: readonly IntegrationPluginV1<any, any, any>[] = Object.freeze([
  bigbrainPlugin,
  notionPlugin,
  githubPlugin,
  linearPlugin,
])

export function firstPartyIntegrationPlugin(key: string): IntegrationPluginV1<any, any, any> | undefined {
  return firstPartyIntegrationPlugins.find((plugin) => plugin.key === key)
}
