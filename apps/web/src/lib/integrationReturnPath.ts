type OAuthProvider = 'github' | 'notion'

export function integrationSettingsPath(provider: OAuthProvider, baseUrl = import.meta.env?.BASE_URL ?? '/') {
  return `${baseUrl.replace(/\/$/, '')}/settings?section=integrations&setting=integration-${provider}`
}

/** Older authorization flows saved only /settings, which opens the personal account page. */
export function integrationReturnPath(
  returnTo: string,
  provider: OAuthProvider,
  baseUrl = import.meta.env?.BASE_URL ?? '/'
) {
  const settingsPath = `${baseUrl.replace(/\/$/, '')}/settings`
  const pathname = returnTo.split(/[?#]/, 1)[0]?.replace(/\/$/, '')
  if (pathname !== '/settings' && pathname !== settingsPath) return returnTo
  const url = new URL(returnTo, 'https://tau.invalid')
  url.pathname = settingsPath
  url.searchParams.set('section', 'integrations')
  url.searchParams.set('setting', `integration-${provider}`)
  return `${url.pathname}${url.search}${url.hash}`
}
