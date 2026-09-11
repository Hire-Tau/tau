export function isRecoverableVoiceConnectionError(message: string | null | undefined): boolean {
  if (!message) return false
  const normalized = message.toLowerCase()
  if (
    normalized.includes('microphone access denied') ||
    normalized.includes('no microphone found') ||
    normalized.includes('microphone is in use') ||
    normalized.includes('missing api key') ||
    normalized.includes('voice not configured')
  ) {
    return false
  }

  return (
    /\b(?:502|503|504|520|521|522|523|524)\b/.test(normalized) ||
    normalized.includes('peer connection') ||
    normalized.includes('data channel') ||
    normalized.includes('connection failed') ||
    normalized.includes('failed to connect') ||
    normalized.includes('voice session failed') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('load failed')
  )
}
