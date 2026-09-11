import type { ExhaustionReason } from './registry'

/**
 * A health decision derived from a provider HTTP response. Returned by
 * {@link classifyResponseHeaders} when the response indicates the provider is
 * exhausted. `exhausted` is always `true` so callers can narrow with a
 * truthiness check.
 */
export interface HeaderSignal {
  exhausted: true
  reason: ExhaustionReason
  /** Epoch ms when to consider the provider available again, if a header said so. */
  retryAt?: number
  /** The HTTP status that produced the signal, if relevant. */
  status?: number
}

/** Case-insensitive header lookup. */
function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k]
  }
  return undefined
}

/**
 * Parse a `retry-after` / `ratelimit-reset` header value into an epoch-ms
 * timestamp. Supports both delta-seconds and HTTP-date forms. Returns
 * `undefined` if the value is absent or unparseable.
 */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  // Delta-seconds form (e.g. "30").
  const secs = Number(trimmed)
  if (!Number.isNaN(secs) && trimmed.length > 0) return Date.now() + secs * 1000
  // HTTP-date form.
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : date
}

/**
 * Classify an HTTP provider response as exhaustion, or `null` if healthy.
 *
 * Inspects status + rate-limit headers (case-insensitively):
 *  - 429 → rate-limit
 *  - 402 (payment required) → plan-credit
 *  - 5xx → null (capacity errors surface via the settled-error path)
 *  - near-zero `*-ratelimit-remaining` on any status → rate-limit (proactive,
 *    before the next call fails)
 *
 * Honored `retry-after` / `ratelimit-reset` / `x-ratelimit-reset` headers
 * override the registry's default cooldown by carrying an explicit `retryAt`.
 *
 * Only marks exhaustion — never reports recovery from a 2xx. The registry's
 * lazy auto-recover at `retryAt` handles recovery; active probes (Item 2) call
 * `markAvailable`.
 */
export function classifyResponseHeaders(status: number, headers: Record<string, string>): HeaderSignal | null {
  let reason: ExhaustionReason | null = null
  if (status === 429) reason = 'rate-limit'
  else if (status === 402) reason = 'plan-credit'
  else if (status >= 500) return null // capacity errors surface via settled-error path

  // Proactive: near-zero remaining on any status (a 2xx with `remaining: 0`
  // means the next call will fail).
  const remaining =
    header(headers, 'x-ratelimit-remaining') ?? header(headers, 'anthropic-ratelimit-requests-remaining')
  if (reason === null && remaining != null && Number(remaining) <= 0) reason = 'rate-limit'

  if (reason === null) return null

  const retryAt =
    parseRetryAfter(header(headers, 'retry-after')) ??
    parseRetryAfter(header(headers, 'ratelimit-reset')) ??
    parseRetryAfter(header(headers, 'x-ratelimit-reset'))

  return { exhausted: true, reason, retryAt, status }
}
