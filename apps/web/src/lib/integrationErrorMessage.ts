import { ApiError } from '../api/client'

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/
const MAX_MESSAGE_LENGTH = 300

/** Friendly text for authorization codes that Core returns without a message. */
const CODE_MESSAGES: Record<string, string> = {
  oauth_app_unconfigured:
    'No GitHub App is configured for this instance. Add your own app or switch back to the Tau app.',
  client_authority_mismatch: "This instance's sign-in settings changed. Reload the page, then try again.",
  invalid_or_expired_state: 'This login expired. Start a new login.',
  broker_unconfigured: "Tau's hosted sign-in isn't available for this instance yet. Try again later.",
}

/**
 * Describe a failed integration request using the server's error body.
 *
 * Core answers `{ error: message, code }` for provider failures and
 * `{ error: code }` for authorization flow rejections. Show the message when
 * there is one, translate known codes, and otherwise keep the code visible next
 * to the fallback so the cause is not lost.
 */
export function integrationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object') return fallback
  const payload = error.payload as Record<string, unknown>
  const detail = typeof payload.error === 'string' ? payload.error.trim() : ''
  const code =
    typeof payload.code === 'string' && CODE_PATTERN.test(payload.code)
      ? payload.code
      : CODE_PATTERN.test(detail)
        ? detail
        : undefined
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  if (detail && detail !== code) return detail.slice(0, MAX_MESSAGE_LENGTH)
  return code ? `${fallback} (${code})` : fallback
}
