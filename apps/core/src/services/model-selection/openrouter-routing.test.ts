import { describe, expect, test } from 'bun:test'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { resolveAgentModelSpec } from '../../lib/utils/model-spec'

function sseResponse(): Response {
  const body = [
    'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
    '',
    'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('OpenRouter outbound routing', () => {
  test('serializes the verified Google endpoint family into the actual request body', async () => {
    const { model } = resolveAgentModelSpec('openrouter:google/gemini-2.5-pro:high')
    let requestBody: any
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return sseResponse()
    }) as typeof globalThis.fetch

    const result = stream(
      model as any,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() }] } as any,
      { apiKey: 'test', fetch, maxRetries: 0 }
    )
    await result.result()

    expect(requestBody.provider).toEqual({
      only: ['google-ai-studio'],
      order: ['google-ai-studio'],
      allow_fallbacks: false,
      require_parameters: true,
    })
    expect(requestBody.provider.order).not.toContain('google')
  })
})
