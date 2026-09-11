export interface RealtimeRetryDelay {
  delayMs: number
  reason: string
}

export function parseRealtimeRateLimitRetryDelay(
  error: { code?: string; message?: string } | undefined
): RealtimeRetryDelay | null {
  if (error?.code !== 'rate_limit_exceeded') return null

  const message = error.message ?? 'Rate limit reached'
  const secondsMatch = message.match(/try again in ([\d.]+)s/i)
  if (secondsMatch) {
    return { delayMs: Math.ceil(Number(secondsMatch[1]) * 1000), reason: message }
  }

  const msMatch = message.match(/try again in ([\d.]+)ms/i)
  if (msMatch) {
    return { delayMs: Math.ceil(Number(msMatch[1])), reason: message }
  }

  return { delayMs: 1000, reason: message }
}
