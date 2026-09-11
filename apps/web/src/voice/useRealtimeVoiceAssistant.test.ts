import { describe, expect, mock, test } from 'bun:test'
import type { VoiceAssistantRuntime } from './useRealtimeVoiceAssistant'
import type { RealtimeSessionConfig } from './realtimeTransport'
import { createMicState } from './micState'
import { isRecoverableVoiceConnectionError } from './voiceConnectionErrors'

const {
  RealtimeTransport,
  applyInitialMicEnabledToTrack,
  calculateInputLevel,
  createVoiceMicConstraints,
  applyDtlnNoiseReductionToSessionConfig,
  resolveDtlnWorkletUrl,
} = await import('./realtimeTransport')
const { applyVoiceInputModeToSessionConfig, appendUserTranscriptDeltaToHistory } =
  await import('./useRealtimeVoiceAssistant')

function makeSessionConfigWithServerVad(): RealtimeSessionConfig {
  return {
    model: 'gpt-realtime',
    instructions: 'Test instructions',
    tools: [],
    output_modalities: ['audio'],
    tool_choice: 'auto',
    audio: {
      input: {
        turn_detection: {
          type: 'server_vad',
          create_response: true,
        },
      },
    },
  }
}

describe('voice mic mute state', () => {
  test('system mic suppression keeps the WebRTC track enabled for barge-in', () => {
    const transport = { setMicEnabled: mock(() => undefined) }
    const transportRef = { current: transport }
    const state = createMicState(transportRef)
    const runtime = { markResponseActive: mock(() => undefined) } as unknown as VoiceAssistantRuntime<unknown>

    state.setMicEnabled(false)
    state.markResponseInactive(runtime)

    expect(transport.setMicEnabled.mock.calls.map((call) => call[0])).toEqual([true, true])
  })

  test('does not let greeting speech leave the mic disabled after user unmutes', () => {
    const transport = { setMicEnabled: mock(() => undefined) }
    const transportRef = { current: transport }
    const state = createMicState(transportRef)
    const runtime = { markResponseActive: mock(() => undefined) } as unknown as VoiceAssistantRuntime<unknown>

    state.setMicEnabled(false)
    state.toggleMicMuted()
    state.toggleMicMuted()
    state.markResponseInactive(runtime)

    expect(transport.setMicEnabled.mock.calls.map((call) => call[0])).toEqual([true, false, true, true])
  })

  test('preserves manual mute when the realtime transport is replaced during reconnect', () => {
    const firstTransport = { setMicEnabled: mock(() => undefined) }
    const secondTransport = { setMicEnabled: mock(() => undefined) }
    const transportRef = { current: firstTransport }
    const state = createMicState(transportRef)

    expect(state.toggleMicMuted()).toBe(true)
    expect(firstTransport.setMicEnabled.mock.calls.map((call) => call[0])).toEqual([false])

    transportRef.current = null
    transportRef.current = secondTransport
    state.applyMicEnabled()

    expect(state.getUserMicEnabled()).toBe(false)
    expect(secondTransport.setMicEnabled.mock.calls.map((call) => call[0])).toEqual([false])
  })
})

describe('RealtimeTransport initial microphone state', () => {
  test('applies manual mode mic disabled state immediately to a local track', () => {
    const track = { enabled: true }

    applyInitialMicEnabledToTrack(track, false)

    expect(track.enabled).toBe(false)
  })

  test('requests browser echo cancellation while leaving noise suppression to DTLN', () => {
    expect(createVoiceMicConstraints()).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        sampleRate: 16000,
      },
    })
  })
})

describe('RealtimeTransport DTLN worklet assets', () => {
  test('resolves worklet URL relative to the Vite base path', () => {
    expect(resolveDtlnWorkletUrl('/tau/')).toBe('/tau/voice/dtln/processor.js?v=3')
    expect(resolveDtlnWorkletUrl('/tau')).toBe('/tau/voice/dtln/processor.js?v=3')
    expect(resolveDtlnWorkletUrl('/')).toBe('/voice/dtln/processor.js?v=3')
  })
})

describe('RealtimeTransport DTLN session config', () => {
  test('uses the GA audio.input.noise_reduction field so DTLN session updates are accepted', () => {
    const config = makeSessionConfigWithServerVad()

    const input = applyDtlnNoiseReductionToSessionConfig(config).audio.input
    expect(input.noise_reduction).toBeNull()
    expect(input).not.toHaveProperty('input_audio_noise_reduction')
  })

  test('preserves the original session config object when enabling DTLN', () => {
    const config = makeSessionConfigWithServerVad()

    expect(applyDtlnNoiseReductionToSessionConfig(config)).not.toBe(config)
    expect(config.audio.input.noise_reduction).toBeUndefined()
  })
})

describe('RealtimeTransport input level', () => {
  test('calculates normalized microphone input level from waveform samples', () => {
    expect(calculateInputLevel(new Uint8Array([128, 128, 128]))).toBe(0)
    expect(calculateInputLevel(new Uint8Array([0, 255, 0, 255]))).toBeGreaterThan(0.9)
  })
})

describe('voice input transcription', () => {
  test('streams input transcription deltas into the active user transcript entry', () => {
    expect(
      appendUserTranscriptDeltaToHistory(
        [
          { role: 'user', text: '', final: false },
          { role: 'assistant', text: 'Hi', final: true },
        ],
        'hello'
      )
    ).toEqual([
      { role: 'user', text: 'hello', final: false },
      { role: 'assistant', text: 'Hi', final: true },
    ])
  })

  test('creates a provisional user transcript entry when a delta arrives before speech_started', () => {
    expect(appendUserTranscriptDeltaToHistory([], 'hello')).toEqual([
      expect.objectContaining({ id: expect.any(String), role: 'user', text: 'hello', final: false }),
    ])
  })
})

describe('voice input session mode', () => {
  test('manual voice input disables realtime turn detection', () => {
    const config = makeSessionConfigWithServerVad()

    expect(applyVoiceInputModeToSessionConfig(config, 'manual').audio.input.turn_detection).toBeNull()
  })

  test('automatic voice input preserves realtime turn detection', () => {
    const config = makeSessionConfigWithServerVad()

    expect(applyVoiceInputModeToSessionConfig(config, 'automatic').audio.input.turn_detection).toEqual({
      type: 'server_vad',
      create_response: true,
    })
  })
})

describe('RealtimeTransport user speech submission', () => {
  test('clears the input audio buffer without requesting a response', () => {
    const sent: unknown[] = []
    const transport = new RealtimeTransport() as unknown as {
      dataChannel: { readyState: string; send: (data: string) => void }
      clearInputAudioBuffer: () => void
    }
    transport.dataChannel = { readyState: 'open', send: (data: string) => sent.push(JSON.parse(data)) }

    transport.clearInputAudioBuffer()

    expect(sent).toEqual([{ type: 'input_audio_buffer.clear' }])
  })

  test('commits the input audio buffer before requesting a response', () => {
    const sent: unknown[] = []
    const transport = new RealtimeTransport() as unknown as {
      dataChannel: { readyState: string; send: (data: string) => void }
      submitInputAudioBuffer: () => void
    }
    transport.dataChannel = { readyState: 'open', send: (data: string) => sent.push(JSON.parse(data)) }

    transport.submitInputAudioBuffer()

    expect(sent).toEqual([{ type: 'input_audio_buffer.commit' }, { type: 'response.create' }])
  })
})

describe('isRecoverableVoiceConnectionError', () => {
  test('treats peer connection disconnects and data channel failures as reconnectable', () => {
    expect(isRecoverableVoiceConnectionError('Peer connection disconnected')).toBe(true)
    expect(isRecoverableVoiceConnectionError('Peer connection failed before data channel opened')).toBe(true)
    expect(isRecoverableVoiceConnectionError('Data channel closed')).toBe(true)
    expect(isRecoverableVoiceConnectionError('Data channel open timeout')).toBe(true)
  })

  test('does not retry configuration or microphone permission failures', () => {
    expect(isRecoverableVoiceConnectionError('Microphone access denied')).toBe(false)
    expect(isRecoverableVoiceConnectionError('No microphone found')).toBe(false)
    expect(isRecoverableVoiceConnectionError('Microphone is in use by another app')).toBe(false)
    expect(isRecoverableVoiceConnectionError('Voice not configured — missing API key')).toBe(false)
  })
})
