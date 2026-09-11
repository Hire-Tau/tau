/** Redact WebSocket credentials from Hono request-log lines before persistence. */
export function redactHttpLogCredentials(message: string): string {
  return message.replace(/([?&](?:token|ticket)=)[^&#\s]*/gi, '$1[REDACTED]')
}
