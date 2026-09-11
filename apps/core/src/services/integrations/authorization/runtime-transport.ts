import { resolveOAuthAuthority } from './authority'
import type { OAuthTransport } from './transport'

/** Selects exactly one transport from deployment mode; hosted never constructs a local fallback. */
export function createRuntimeOAuthTransport(factories: {
  local(): OAuthTransport
  broker(): OAuthTransport
}): OAuthTransport {
  return resolveOAuthAuthority() === 'platform_broker' ? factories.broker() : factories.local()
}
