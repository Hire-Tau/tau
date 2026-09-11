import type { SecretValidation } from './types'

const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_VALIDATION_TIMEOUT_MS = 8_000

export interface ValidateGitHubTokenOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Defaults to {@link GITHUB_VALIDATION_TIMEOUT_MS}. */
  timeoutMs?: number
}

const MSG_INVALID =
  'GitHub rejected this token (401 Unauthorized). It was NOT saved — check that you copied the full token and that it has not expired or been revoked.'

/**
 * Validate a candidate GitHub token by asking GitHub who it authenticates as.
 * Never throws, logs, or returns the token or GitHub response body.
 */
export async function validateGitHubToken(
  candidate: string,
  { fetchImpl = fetch, timeoutMs = GITHUB_VALIDATION_TIMEOUT_MS }: ValidateGitHubTokenOptions = {}
): Promise<SecretValidation> {
  let res: Response
  try {
    res = await fetchImpl(`${GITHUB_API_BASE}/user`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${candidate}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return {
      status: 'unverified',
      message: timedOut
        ? 'GitHub did not respond in time, so the token could not be validated.'
        : 'GitHub could not be reached, so the token could not be validated.',
    }
  }

  if (res.status === 401) return { status: 'invalid', message: MSG_INVALID }
  if (res.status === 403) {
    return {
      status: 'unverified',
      message:
        'GitHub returned 403 for this token (organization SAML enforcement or an IP allow-list can cause this), so it could not be fully validated.',
    }
  }
  if (!res.ok) {
    return { status: 'unverified', message: `GitHub returned ${res.status}, so the token could not be validated.` }
  }

  let body: { login?: unknown }
  try {
    body = (await res.json()) as { login?: unknown }
  } catch {
    return {
      status: 'unverified',
      message: 'GitHub returned an unexpected response, so the token could not be validated.',
    }
  }
  if (typeof body.login !== 'string' || body.login === '') {
    return {
      status: 'unverified',
      message: 'GitHub returned an unexpected response, so the token could not be validated.',
    }
  }

  const scopesHeader = res.headers.get('x-oauth-scopes')
  if (scopesHeader === null) {
    return { status: 'valid', login: body.login, tokenType: 'fine-grained', warnings: [] }
  }
  const scopes = scopesHeader
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
  const warnings = scopes.includes('repo')
    ? []
    : [
        `This token authenticates as @${body.login} (classic PAT) but is missing the 'repo' scope` +
          ` (has: ${scopes.length ? scopes.join(', ') : 'none'}). Git operations on private repositories will fail unless this narrower token is intentional.`,
      ]
  return { status: 'valid', login: body.login, tokenType: 'classic', scopes, warnings }
}
