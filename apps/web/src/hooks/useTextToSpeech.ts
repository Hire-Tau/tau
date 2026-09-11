import { useState, useRef, useCallback, useEffect } from 'react'
import { synthesizeSpeech } from '../api/tts'

const TTS_ENABLED_KEY = 'tts-enabled'
const SAMPLE_RATE = 24000

export function useTextToSpeech() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(TTS_ENABLED_KEY) === 'true')
  const [isPlaying, setIsPlaying] = useState(false)
  const [isSynthesizing, setIsSynthesizing] = useState(false)
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextStartTimeRef = useRef(0)
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())

  const cleanup = useCallback(() => {
    // Abort any in-flight fetch
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    // Stop all active audio sources
    for (const source of activeSourcesRef.current) {
      try {
        source.stop()
      } catch {
        // ignore stop errors
      }
    }
    activeSourcesRef.current.clear()
    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    nextStartTimeRef.current = 0
    setIsPlaying(false)
    setIsSynthesizing(false)
    setPlayingMessageId(null)
  }, [])

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup])

  const speak = useCallback(
    async (messageId: string) => {
      // Stop any current playback
      cleanup()

      const abortController = new AbortController()
      abortControllerRef.current = abortController

      setIsSynthesizing(true)
      setPlayingMessageId(messageId)

      try {
        const response = await synthesizeSpeech(messageId, abortController.signal)
        const reader = response.body?.getReader()
        if (!reader) {
          cleanup()
          return
        }

        const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
        audioContextRef.current = audioContext

        // Resume if suspended (browser autoplay policy)
        if (audioContext.state === 'suspended') {
          await audioContext.resume()
        }

        nextStartTimeRef.current = audioContext.currentTime
        let receivedFirstChunk = false
        // Buffer for incomplete samples (LINEAR16 = 2 bytes per sample)
        let leftover = new Uint8Array(0)

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          if (!receivedFirstChunk) {
            receivedFirstChunk = true
            setIsSynthesizing(false)
            setIsPlaying(true)
          }

          // Combine leftover bytes with new chunk
          const combined = new Uint8Array(leftover.length + value.length)
          combined.set(leftover)
          combined.set(value, leftover.length)

          // Process only complete samples (2 bytes each)
          const usableBytes = combined.length - (combined.length % 2)
          leftover = combined.slice(usableBytes)

          if (usableBytes === 0) continue

          const dataView = new DataView(combined.buffer, combined.byteOffset, usableBytes)
          const sampleCount = usableBytes / 2
          const float32 = new Float32Array(sampleCount)
          for (let i = 0; i < sampleCount; i++) {
            float32[i] = dataView.getInt16(i * 2, true) / 32768
          }

          const audioBuffer = audioContext.createBuffer(1, sampleCount, SAMPLE_RATE)
          audioBuffer.getChannelData(0).set(float32)

          const source = audioContext.createBufferSource()
          source.buffer = audioBuffer
          source.connect(audioContext.destination)

          const startTime = Math.max(nextStartTimeRef.current, audioContext.currentTime)
          source.start(startTime)
          nextStartTimeRef.current = startTime + audioBuffer.duration

          activeSourcesRef.current.add(source)
          source.onended = () => {
            activeSourcesRef.current.delete(source)
            // If all sources are done and stream is finished, cleanup
            if (activeSourcesRef.current.size === 0) {
              setIsPlaying(false)
              setPlayingMessageId(null)
              if (audioContextRef.current) {
                audioContextRef.current.close()
                audioContextRef.current = null
              }
            }
          }
        }

        // If we never got any audio, cleanup
        if (!receivedFirstChunk) {
          cleanup()
        }
      } catch (error) {
        // Ignore abort errors (from stop())
        if (error instanceof DOMException && error.name === 'AbortError') return
        cleanup()
      }
    },
    [cleanup]
  )

  const stop = useCallback(() => {
    cleanup()
  }, [cleanup])

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      localStorage.setItem(TTS_ENABLED_KEY, String(next))
      return next
    })
  }, [])

  return {
    enabled,
    isPlaying,
    isSynthesizing,
    playingMessageId,
    speak,
    stop,
    toggle,
  }
}
