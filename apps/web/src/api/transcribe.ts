import { authFetch } from './client'

export async function transcribeAudio(audioBlob: Blob): Promise<{ text: string }> {
  const formData = new FormData()
  formData.append('audio', audioBlob, 'recording.webm')

  const response = await authFetch('/transcribe', {
    method: 'POST',
    body: formData,
    // Don't set Content-Type — browser sets it with boundary for multipart
  })

  if (!response.ok) {
    throw new Error(`Transcription failed: ${response.status}`)
  }

  return response.json()
}
