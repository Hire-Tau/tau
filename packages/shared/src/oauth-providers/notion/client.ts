const API_ORIGIN = 'https://api.notion.com'
const NOTION_VERSION = '2026-03-11'
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60
const PROVIDER_ERROR_CODES: Readonly<Record<string, string>> = {
  invalid_grant: 'invalid_grant',
  invalid_auth: 'invalid_auth',
  unauthorized: 'invalid_auth',
  invalid_client: 'invalid_auth',
  restricted_resource: 'capability_or_resource_denied',
  object_not_found: 'capability_or_resource_denied',
  rate_limited: 'rate_limited',
}

export class NotionClientError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly providerRateLimited?: true,
    readonly retryAfterSeconds?: number
  ) {
    super(code)
    this.name = 'NotionClientError'
  }
}

export interface NotionTokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  workspaceId: string
  workspaceName: string | null
  workspaceIcon: string | null
  botId: string
}

type NotionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface NotionClientOptions {
  fetch?: NotionFetch
  timeoutMs?: number
  now?: () => Date
}

export class NotionClient {
  readonly #fetch: NotionFetch
  readonly #timeoutMs: number
  readonly #now: () => Date

  constructor(options: NotionClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(options.timeoutMs!, 30_000))
      : DEFAULT_TIMEOUT_MS
    this.#now = options.now ?? (() => new Date())
  }

  buildAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): URL {
    const url = new URL('/v1/oauth/authorize', API_ORIGIN)
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('owner', 'user')
    url.searchParams.set('state', input.state)
    return url
  }

  exchangeCode(input: {
    code: string
    clientId: string
    clientSecret: string
    redirectUri: string
    signal?: AbortSignal
  }): Promise<NotionTokenResponse> {
    return this.#tokenRequest(
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
      },
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
  }): Promise<NotionTokenResponse> {
    return this.#tokenRequest(
      { grant_type: 'refresh_token', refresh_token: input.refreshToken },
      input.clientId,
      input.clientSecret,
      input.signal
    )
  }

  async revoke(input: { token: string; clientId: string; clientSecret: string; signal?: AbortSignal }): Promise<void> {
    await this.#request('/v1/oauth/revoke', {
      method: 'POST',
      headers: this.#oauthHeaders(input.clientId, input.clientSecret),
      body: JSON.stringify({ token: input.token }),
      signal: input.signal,
    })
  }

  async currentBot(input: { accessToken: string; signal?: AbortSignal }): Promise<{ botId: string }> {
    const value = await this.#request('/v1/users/me', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'notion-version': NOTION_VERSION,
        accept: 'application/json',
      },
      signal: input.signal,
    })
    const row = requireRecord(value)
    if (!onlyKnownKeys(row, ['id', 'type', 'name', 'avatar_url', 'bot', 'object', 'request_id'])) {
      throw new NotionClientError('invalid_response')
    }
    if (
      row.object !== 'user' ||
      row.type !== 'bot' ||
      !isBoundedString(row.id, 256) ||
      !nullableBoundedString(row.name, 512) ||
      !nullableBoundedString(row.avatar_url, 2_048) ||
      !row.bot ||
      typeof row.bot !== 'object' ||
      Array.isArray(row.bot)
    ) {
      throw new NotionClientError('invalid_response')
    }
    return { botId: row.id }
  }

  async #tokenRequest(
    body: Record<string, string>,
    clientId: string,
    clientSecret: string,
    signal?: AbortSignal
  ): Promise<NotionTokenResponse> {
    const value = await this.#request('/v1/oauth/token', {
      method: 'POST',
      headers: this.#oauthHeaders(clientId, clientSecret),
      body: JSON.stringify(body),
      signal,
    })
    return parseTokenResponse(value, this.#now())
  }

  #oauthHeaders(clientId: string, clientSecret: string): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'notion-version': NOTION_VERSION,
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
      throw new NotionClientError(controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable')
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => {})
      const retryAfter = response.headers.get('retry-after')
      const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined
      throw new NotionClientError(
        'rate_limited',
        response.status,
        true,
        Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : undefined
      )
    }

    let value: unknown
    try {
      value = JSON.parse(await readBoundedBody(response))
    } catch (error) {
      if (error instanceof NotionClientError) throw error
      throw new NotionClientError('invalid_response', response.status)
    }
    if (!response.ok) throw parseProviderError(value, response.status)
    return value
  }
}

function parseTokenResponse(value: unknown, now: Date): NotionTokenResponse {
  const row = requireRecord(value)
  if (
    !onlyKnownKeys(row, [
      'access_token',
      'refresh_token',
      'workspace_id',
      'workspace_name',
      'workspace_icon',
      'bot_id',
      'expires_in',
      'token_type',
      'owner',
      'duplicated_template_id',
      'request_id',
    ]) ||
    row.token_type !== 'bearer' ||
    !row.owner ||
    typeof row.owner !== 'object' ||
    Array.isArray(row.owner) ||
    (row.duplicated_template_id !== null && !isBoundedString(row.duplicated_template_id, 256)) ||
    !isBoundedString(row.access_token, 16_384) ||
    (row.refresh_token !== null && row.refresh_token !== undefined && !isBoundedString(row.refresh_token, 16_384)) ||
    !isBoundedString(row.workspace_id, 256) ||
    !nullableBoundedString(row.workspace_name, 512) ||
    !nullableBoundedString(row.workspace_icon, 2_048) ||
    !isBoundedString(row.bot_id, 256)
  ) {
    throw new NotionClientError('invalid_response')
  }
  let expiresAt: string | null = null
  if (row.expires_in !== undefined) {
    if (
      !Number.isSafeInteger(row.expires_in) ||
      (row.expires_in as number) < 0 ||
      (row.expires_in as number) > MAX_EXPIRES_IN_SECONDS
    ) {
      throw new NotionClientError('invalid_response')
    }
    expiresAt = new Date(now.getTime() + (row.expires_in as number) * 1_000).toISOString()
  }
  return {
    accessToken: row.access_token,
    refreshToken: typeof row.refresh_token === 'string' ? row.refresh_token : null,
    expiresAt,
    workspaceId: row.workspace_id,
    workspaceName: typeof row.workspace_name === 'string' ? row.workspace_name : null,
    workspaceIcon: normalizeWorkspaceIcon(row.workspace_icon),
    botId: row.bot_id,
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new NotionClientError('response_too_large', response.status)
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
      throw new NotionClientError('response_too_large', response.status)
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

function parseProviderError(value: unknown, status: number): NotionClientError {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const raw = typeof row.code === 'string' ? row.code : typeof row.error === 'string' ? row.error : ''
  const code =
    PROVIDER_ERROR_CODES[raw] ??
    (status === 401
      ? 'invalid_auth'
      : status === 403
        ? 'capability_or_resource_denied'
        : status === 429
          ? 'rate_limited'
          : status >= 500
            ? 'provider_unavailable'
            : 'provider_error')
  return new NotionClientError(code, status)
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotionClientError('invalid_response')
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

function normalizeWorkspaceIcon(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}
