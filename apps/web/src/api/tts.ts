import { authFetch } from './client'

export async function synthesizeSpeech(messageId: string, signal?: AbortSignal): Promise<Response> {
  const response = await authFetch('/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Speech synthesis failed: ${response.status}`)
  }

  return response
}
