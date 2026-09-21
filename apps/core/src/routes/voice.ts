import { getSettingsStore } from '../services/settings'
import { Hono } from 'hono'
import { getOpenAIServiceKey } from '../services/integrations/openai-services/settings'
import { requireAnyPermission } from '../middleware/require-permission'

/**
 * Voice capability status.
 *
 * Both voice entry points need an OpenAI API key: the realtime companion
 * (`POST /api/voice-session`) and push-to-talk transcription
 * (`POST /api/transcribe`). Clients call this to decide whether to offer a
 * microphone at all, so they never render a control that silently fails.
 *
 * The key is resolved through the secret store, which already covers both the
 * DB-backed and env-delivered (platform-managed) cases — so this reports the
 * same value the voice routes themselves will resolve.
 *
 * The response is a boolean capability and nothing more: the key, its length,
 * and any prefix of it are never returned.
 */
export const voiceRouter = new Hono().get(
  '/status',
  // Anyone who could use either microphone may ask whether it would work.
  requireAnyPermission('ai:voice', 'ai:transcribe'),
  (c) => {
    // A key set to '' or '   ' is not a usable key — report voice as disabled
    // rather than offering a microphone that fails on first use.
    const apiKey = getOpenAIServiceKey()
    const enabled = (apiKey ?? '').trim().length > 0
    return c.json({
      enabled,
      transcriptionEnabled: enabled && getSettingsStore().getTyped('TRANSCRIPTION_ENABLED') === true,
      realtimeEnabled: enabled && getSettingsStore().getTyped('ASSISTANT_REALTIME_ENABLED') === true,
    })
  }
)
