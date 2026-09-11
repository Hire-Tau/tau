import { useState, useCallback, useRef } from 'react'

const STORAGE_KEY = 'notification-sound-enabled'

/**
 * Generate a pleasant two-tone "ping" notification sound using Web Audio API.
 * No external audio files required.
 */
export function createPingSound(audioContext: AudioContext): void {
  const now = audioContext.currentTime

  // Create two oscillators for a two-tone chime
  const osc1 = audioContext.createOscillator()
  const osc2 = audioContext.createOscillator()
  const gainNode = audioContext.createGain()

  // Pleasant frequencies (C5 and E5 - major third interval)
  osc1.frequency.value = 523.25 // C5
  osc2.frequency.value = 659.25 // E5

  osc1.type = 'sine'
  osc2.type = 'sine'

  // Connect oscillators through gain node
  osc1.connect(gainNode)
  osc2.connect(gainNode)
  gainNode.connect(audioContext.destination)

  // Envelope: quick attack, short sustain, smooth decay
  gainNode.gain.setValueAtTime(0, now)
  gainNode.gain.linearRampToValueAtTime(0.3, now + 0.02) // Attack
  gainNode.gain.linearRampToValueAtTime(0.2, now + 0.08) // Sustain
  gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.3) // Decay

  // Start and stop oscillators
  osc1.start(now)
  osc2.start(now + 0.05) // Slight delay for second tone
  osc1.stop(now + 0.3)
  osc2.stop(now + 0.35)
}

export function useNotificationSound() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')
  const audioContextRef = useRef<AudioContext | null>(null)

  const playSound = useCallback(() => {
    if (!enabled) return

    try {
      // Create or reuse audio context
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new AudioContext()
      }

      const ctx = audioContextRef.current

      // Resume if suspended (browser autoplay policy)
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => createPingSound(ctx))
      } else {
        createPingSound(ctx)
      }
    } catch (error) {
      console.warn('Failed to play notification sound:', error)
    }
  }, [enabled])

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }, [])

  return {
    enabled,
    playSound,
    toggle,
  }
}
