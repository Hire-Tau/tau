import type { IntegrationPluginV1, OAuth2Authorization } from './plugin'
import type { OAuthAuthority } from './authorization/authority'
import {
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from './authorization/credential-bundle'

/** An `IntegrationPluginV1` narrowed to its OAuth2 shape, whether that is the plugin's own `authorization` or a manual plugin's `managed` driver. */
export type OAuthPluginView<C> = IntegrationPluginV1<C, OAuthCredentialBundleV1> & {
  readonly authorization: OAuth2Authorization<C, OAuthCredentialBundleV1>
}

/**
 * The OAuth-flow-only view of a plugin: itself when it is a true OAuth2
 * plugin, or a manual plugin's `managed` driver reshaped to the same
 * contract when `authority` is one it is offered under. Every other call
 * site keeps reading `plugin.authorization.kind` directly, so manual-only
 * and manual+managed plugins keep meaning "manual" everywhere except here.
 */
export function oauthPluginView<C>(
  plugin: IntegrationPluginV1<C, unknown>,
  authority: OAuthAuthority
): OAuthPluginView<C> | undefined {
  if (plugin.authorization.kind === 'oauth2') return plugin as OAuthPluginView<C>
  const managed = plugin.authorization.managed
  if (!managed || !managed.authorities.includes(authority)) return undefined
  return {
    ...plugin,
    connection: {
      ...plugin.connection,
      credential: { parse: parseOAuthCredential, serialize: serializeOAuthCredential },
    },
    authorization: managed,
  }
}
