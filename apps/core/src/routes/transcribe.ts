import { Hono } from 'hono'
import OpenAI from 'openai'
import { createLogger } from '../lib/infra/logger'
import { getOpenAIServiceKey } from '../services/integrations/openai-services/settings'
import { requirePermission } from '../middleware/require-permission'

import { getSettingsStore } from '../services/settings'

const log = createLogger('routes')

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

export function createTranscribeRouter(
  transcribe: (apiKey: string, audio: File) => Promise<{ text: string }> = async (apiKey, audio) =>
    new OpenAI({ apiKey }).audio.transcriptions.create({ file: audio, model: 'whisper-1' })
) {
  return new Hono().post('/', requirePermission('ai:transcribe'), async (c) => {
    if (!getSettingsStore().getTyped('TRANSCRIPTION_ENABLED'))
      return c.json({ error: 'Voice dictation is disabled in Settings → Assistant & Memory.' }, 503)
    const formData = await c.req.formData()
    const audio = formData.get('audio')

    if (!audio || !(audio instanceof File)) {
      return c.json({ error: 'Missing audio file' }, 400)
    }

    if (audio.size > MAX_FILE_SIZE) {
      return c.json({ error: 'File too large (max 10MB)' }, 413)
    }

    const apiKey = getOpenAIServiceKey()
    if (!apiKey)
      return c.json({ error: 'Enable OpenAI API services and configure an API key in Settings → Integrations.' }, 503)

    try {
      const transcription = await transcribe(apiKey, audio)

      return c.json({ text: transcription.text })
    } catch (error) {
      log.error('Transcription error:', error)
      return c.json({ error: 'Transcription failed' }, 502)
    }
  })
}
export const transcribeRouter = createTranscribeRouter()
