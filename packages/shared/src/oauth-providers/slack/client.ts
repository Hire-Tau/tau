const API_ORIGIN = 'https://slack.com'
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60

// Bot-scoped OAuth v2 scopes requested during install, taken from
// config/channels/slack-app-manifest.example.yaml. No user scopes: the platform
// app only ever installs as a bot, never on behalf of an individual user.
export const SLACK_BOT_SCOPES = [
  'commands',
  'chat:write',
  'chat:write.public',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'channels:join',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'reactions:write',
  'reactions:read',
  'files:write',
  'files:read',
  'im:write',
  'app_mentions:read',
] as const

// Slack's own object ID prefixes. Validating them lets us reject malformed or
// unexpected identifiers up front instead of trusting bounded-string checks alone.
const TEAM_ID_PATTERN = /^T[A-Z0-9]{2,30}$/
const USER_ID_PATTERN = /^U[A-Z0-9]{2,30}$/
const APP_ID_PATTERN = /^A[A-Z0-9]{2,30}$/
const BOT_ID_PATTERN = /^B[A-Z0-9]{2,30}$/
const ENTERPRISE_ID_PATTERN = /^E[A-Z0-9]{2,30}$/

// Slack maps failures onto a small set of documented `error` strings rather than
// HTTP status codes (oauth.v2.access itself replies HTTP 200 even on failure).
const GRANT_ERROR_CODES = new Set(['invalid_code', 'code_already_used', 'bad_redirect_uri'])
const AUTH_ERROR_CODES = new Set(['invalid_client_id', 'bad_client_secret', 'invalid_auth'])
// The broker's Slack revoke path treats these as "already revoked" successes,
// mirroring how invalid_auth is already tolerated for other providers.
const ALREADY_REVOKED_ERROR_CODES = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'])

export class SlackClientError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly providerRateLimited?: true,
    readonly retryAfterSeconds?: number
  ) {
    super(code)
    this.name = 'SlackClientError'
  }
}

export interface SlackTokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  appId: string
  botUserId: string
  team: { id: string; name: string | null }
}

export interface SlackAuthTestResponse {
  teamId: string
  userId: string
  botId: string
  enterpriseId: string | null
  isEnterpriseInstall: boolean
}

export interface SlackBotInfoResponse {
  appId: string
  teamId: string | null
}

type SlackFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface SlackClientOptions {
  fetch?: SlackFetch
  timeoutMs?: number
  now?: () => Date
}

export class SlackClient {
  readonly #fetch: SlackFetch
  readonly #timeoutMs: number
  readonly #now: () => Date

  constructor(options: SlackClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(options.timeoutMs!, 30_000))
      : DEFAULT_TIMEOUT_MS
    this.#now = options.now ?? (() => new Date())
  }

  buildAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): URL {
    const url = new URL('/oauth/v2/authorize', API_ORIGIN)
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','))
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('state', input.state)
    return url
  }

  exchangeCode(input: {
    code: string
    clientId: string
    clientSecret: string
    redirectUri: string
    signal?: AbortSignal
  }): Promise<SlackTokenResponse> {
    return this.#tokenRequest(
      { code: input.code, redirect_uri: input.redirectUri },
      input.clientId,
      input.clientSecret,
      input.signal
    )
  }

  refresh(input: {
    refreshToken: string
    clientId: string
    clientSecret: string
    signal?: AbortSignal
  }): Promise<SlackTokenResponse> {
    // Only takes effect when token rotation is enabled on the Slack app; our
    // production app currently has rotation off, but this is implemented for
    // correctness and to support turning rotation on later without a rewrite.
    return this.#tokenRequest(
      { grant_type: 'refresh_token', refresh_token: input.refreshToken },
      input.clientId,
      input.clientSecret,
      input.signal
    )
  }

  async revoke(input: {
    token: string
    // Unused for Slack: auth.revoke authenticates solely via the bearer token
    // being revoked, unlike Notion/GitHub which need the issuing app's credentials.
    clientId: string
    clientSecret: string
    signal?: AbortSignal
  }): Promise<void> {
    const value = await this.#request('/api/auth.revoke', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: '',
      signal: input.signal,
    })
    const row = requireRecord(value)
    if (row.ok === true) {
      if (row.revoked !== true) throw new SlackClientError('invalid_response')
      return
    }
    const raw = typeof row.error === 'string' ? row.error : ''
    if (ALREADY_REVOKED_ERROR_CODES.has(raw)) return
    throw parseApiError(raw)
  }

  async authTest(input: { accessToken: string; signal?: AbortSignal }): Promise<SlackAuthTestResponse> {
    const value = await this.#request('/api/auth.test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: '',
      signal: input.signal,
    })
    const row = requireRecord(value)
    if (row.ok !== true) {
      throw parseApiError(typeof row.error === 'string' ? row.error : '')
    }
    if (
      !onlyKnownKeys(row, [
        'ok',
        'url',
        'team',
        'user',
        'team_id',
        'user_id',
        'bot_id',
        'enterprise_id',
        'is_enterprise_install',
      ]) ||
      !isBoundedString(row.url, 2_048) ||
      !isBoundedString(row.team, 512) ||
      !isBoundedString(row.user, 512) ||
      !matches(row.team_id, TEAM_ID_PATTERN) ||
      !matches(row.user_id, USER_ID_PATTERN) ||
      !matches(row.bot_id, BOT_ID_PATTERN) ||
      (row.enterprise_id !== undefined &&
        row.enterprise_id !== null &&
        !matches(row.enterprise_id, ENTERPRISE_ID_PATTERN)) ||
      (row.is_enterprise_install !== undefined && typeof row.is_enterprise_install !== 'boolean')
    ) {
      throw new SlackClientError('invalid_response')
    }
    return {
      teamId: row.team_id,
      userId: row.user_id,
      botId: row.bot_id,
      enterpriseId: typeof row.enterprise_id === 'string' ? row.enterprise_id : null,
      isEnterpriseInstall: row.is_enterprise_install === true,
    }
  }

  async botInfo(input: { accessToken: string; botId: string; signal?: AbortSignal }): Promise<SlackBotInfoResponse> {
    const url = new URL('/api/bots.info', API_ORIGIN)
    url.searchParams.set('bot', input.botId)
    const value = await this.#request(url.pathname + url.search, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        accept: 'application/json',
      },
      signal: input.signal,
    })
    const row = requireRecord(value)
    if (row.ok !== true) {
      throw parseApiError(typeof row.error === 'string' ? row.error : '')
    }
    if (!row.bot || typeof row.bot !== 'object' || Array.isArray(row.bot))
      throw new SlackClientError('invalid_response')
    const bot = row.bot as Record<string, unknown>
    if (
      !onlyKnownKeys(bot, ['id', 'deleted', 'name', 'updated', 'app_id', 'user_id', 'team_id', 'icons']) ||
      !matches(bot.id, BOT_ID_PATTERN) ||
      typeof bot.deleted !== 'boolean' ||
      !isBoundedString(bot.name, 512) ||
      !Number.isSafeInteger(bot.updated) ||
      !matches(bot.app_id, APP_ID_PATTERN) ||
      !matches(bot.user_id, USER_ID_PATTERN) ||
      (bot.team_id !== undefined && !matches(bot.team_id, TEAM_ID_PATTERN)) ||
      (bot.icons !== undefined && (typeof bot.icons !== 'object' || bot.icons === null || Array.isArray(bot.icons)))
    ) {
      throw new SlackClientError('invalid_response')
    }
    return {
      appId: bot.app_id as string,
      teamId: typeof bot.team_id === 'string' ? bot.team_id : null,
    }
  }

  async #tokenRequest(
    fields: Record<string, string>,
    clientId: string,
    clientSecret: string,
    signal?: AbortSignal
  ): Promise<SlackTokenResponse> {
    const value = await this.#request('/api/oauth.v2.access', {
      method: 'POST',
      headers: this.#oauthHeaders(clientId, clientSecret),
      body: new URLSearchParams(fields).toString(),
      signal,
    })
    const row = requireRecord(value)
    if (row.ok !== true) {
      throw parseApiError(typeof row.error === 'string' ? row.error : '')
    }
    return parseTokenResponse(row, this.#now())
  }

  #oauthHeaders(clientId: string, clientSecret: string): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    }
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
    let response: Response
    try {
      response = await this.#fetch(`${API_ORIGIN}${path}`, {
        ...init,
        redirect: 'error',
        signal,
      })
    } catch {
      throw new SlackClientError(controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable')
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => {})
      const retryAfter = response.headers.get('retry-after')
      const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined
      throw new SlackClientError(
        'rate_limited',
        response.status,
        true,
        Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : undefined
      )
    }
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => {})
      throw new SlackClientError('provider_unavailable', response.status)
    }

    // Slack's Web API replies HTTP 200 with `{ok:false,error:"..."}` for almost
    // all failures (bad code, bad auth, etc). We always parse and return the
    // body; callers inspect `ok` themselves rather than relying on response.ok.
    let value: unknown
    try {
      value = JSON.parse(await readBoundedBody(response))
    } catch (error) {
      if (error instanceof SlackClientError) throw error
      throw new SlackClientError('invalid_response', response.status)
    }
    return value
  }
}

function parseTokenResponse(row: Record<string, unknown>, now: Date): SlackTokenResponse {
  // Slack documents additional top-level keys on this response (scope,
  // authed_user, enterprise, incoming_webhook, warning, response_metadata) and
  // adds new ones over time. We deliberately do not enforce an exhaustive
  // known-key allowlist here (unlike Notion/GitHub) so unannounced additions
  // don't break token exchange; we do strictly validate every field we use.
  if (
    row.token_type !== 'bot' ||
    !isBoundedString(row.access_token, 4_096) ||
    !/^xoxb-/.test(row.access_token as string) ||
    !matches(row.bot_user_id, USER_ID_PATTERN) ||
    !matches(row.app_id, APP_ID_PATTERN) ||
    !row.team ||
    typeof row.team !== 'object' ||
    Array.isArray(row.team)
  ) {
    throw new SlackClientError('invalid_response')
  }
  const team = row.team as Record<string, unknown>
  if (
    !onlyKnownKeys(team, ['id', 'name']) ||
    !matches(team.id, TEAM_ID_PATTERN) ||
    !nullableBoundedString(team.name, 512)
  ) {
    throw new SlackClientError('invalid_response')
  }
  if (row.is_enterprise_install !== undefined && typeof row.is_enterprise_install !== 'boolean') {
    throw new SlackClientError('invalid_response')
  }
  if (row.is_enterprise_install === true) {
    // Org-wide (Enterprise Grid) installs are out of scope: the platform relay
    // and broker only model single-workspace connections.
    throw new SlackClientError('unsupported_enterprise_install')
  }
  if (row.refresh_token !== undefined && row.refresh_token !== null && !isBoundedString(row.refresh_token, 4_096)) {
    throw new SlackClientError('invalid_response')
  }
  let expiresAt: string | null = null
  if (row.expires_in !== undefined && row.expires_in !== null) {
    if (
      !Number.isSafeInteger(row.expires_in) ||
      (row.expires_in as number) < 0 ||
      (row.expires_in as number) > MAX_EXPIRES_IN_SECONDS
    ) {
      throw new SlackClientError('invalid_response')
    }
    expiresAt = new Date(now.getTime() + (row.expires_in as number) * 1_000).toISOString()
  }
  return {
    accessToken: row.access_token as string,
    refreshToken: typeof row.refresh_token === 'string' ? row.refresh_token : null,
    expiresAt,
    appId: row.app_id as string,
    botUserId: row.bot_user_id as string,
    team: {
      id: team.id as string,
      name: typeof team.name === 'string' ? team.name : null,
    },
  }
}

function parseApiError(raw: string): SlackClientError {
  if (raw === 'ratelimited') return new SlackClientError('rate_limited')
  if (GRANT_ERROR_CODES.has(raw)) return new SlackClientError('invalid_grant')
  if (AUTH_ERROR_CODES.has(raw)) return new SlackClientError('invalid_auth')
  return new SlackClientError('provider_error')
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new SlackClientError('response_too_large', response.status)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new SlackClientError('response_too_large', response.status)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body)
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SlackClientError('invalid_response')
  return value as Record<string, unknown>
}

function onlyKnownKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const known = new Set(keys)
  return Object.keys(row).every((key) => known.has(key))
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
}

function nullableBoundedString(value: unknown, max: number): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= max)
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}
