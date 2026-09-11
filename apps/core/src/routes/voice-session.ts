import { getSettingsStore } from '../services/settings'
import { Hono } from 'hono'
import { getOpenAIServiceKey } from '../services/integrations/openai-services/settings'
import { createLogger } from '../lib/infra/logger'
import { requirePermission } from '../middleware/require-permission'

const log = createLogger('voice-session')

export const voiceSessionRouter = new Hono().post('/', requirePermission('ai:voice'), async (c) => {
  try {
    if (!getSettingsStore().getTyped('ASSISTANT_REALTIME_ENABLED'))
      return c.json({ error: 'Realtime assistant is disabled in Settings → Assistant & Memory.' }, 503)
    // Client sends multipart form data with 'sdp' and optional 'session' fields.
    // OpenAI's direct /v1/realtime/calls endpoint expects just the SDP as the body
    // with Content-Type: application/sdp. Session config is sent separately via
    // the data channel session.update event after connection.
    const formData = await c.req.formData()
    const sdp = formData.get('sdp')
    const sessionJson = formData.get('session')

    if (!sdp || typeof sdp !== 'string') {
      return c.json({ error: 'Missing required "sdp" field in form data' }, 400)
    }

    const apiKey = getOpenAIServiceKey()
    if (!apiKey) {
      return c.json({ error: 'Enable OpenAI API services and configure an API key in Settings → Integrations.' }, 503)
    }

    // Extract model from session config, default to gpt-realtime-2
    let model = 'gpt-realtime-2'
    if (sessionJson && typeof sessionJson === 'string') {
      try {
        const session = JSON.parse(sessionJson)
        if (session.model) model = session.model
      } catch {
        // ignore parse errors, use default model
      }
    }

    const realtimeResponse = await fetch(
      `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/sdp',
        },
        body: sdp,
      }
    )

    if (!realtimeResponse.ok) {
      const errorText = await realtimeResponse.text()
      log.error('Realtime API error:', realtimeResponse.status, errorText)
      return new Response(errorText, {
        status: realtimeResponse.status,
        headers: {
          'Content-Type': realtimeResponse.headers.get('content-type') ?? 'text/plain; charset=utf-8',
        },
      })
    }

    return new Response(await realtimeResponse.text(), {
      status: 200,
      headers: {
        'Content-Type': realtimeResponse.headers.get('content-type') ?? 'application/sdp; charset=utf-8',
      },
    })
  } catch (error) {
    log.error('Voice session proxy error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unexpected voice session error' }, 500)
  }
})
