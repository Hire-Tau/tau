import { useState, useRef, useCallback, useEffect } from 'react'

export type RecorderState = 'idle' | 'recording' | 'transcribing'

interface UseVoiceRecorderOptions {
  onTranscription: (text: string) => void
  onAutoSend?: (text: string) => void
  onError?: (error: string) => void
  transcribe: (blob: Blob) => Promise<{ text: string }>
  disabled?: boolean // Prevents starting recording when true
}

export function useVoiceRecorder({
  onTranscription,
  onAutoSend,
  onError,
  transcribe,
  disabled,
}: UseVoiceRecorderOptions) {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [volume, setVolume] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const autoSendRef = useRef(false)
  const cancelledRef = useRef(false)
  const recordingStartRef = useRef(0)
  const peakVolumeRef = useRef(0)

  // Press tracking for tap-toggle vs hold-to-talk
  const pressStartRef = useRef(0)
  const wasRecordingOnPressRef = useRef(false)
  const [isHoldMode, setIsHoldMode] = useState(false)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdCancelledRef = useRef(false)

  const isSupported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

  const cleanupAudio = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    setVolume(0)
  }, [])

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    cleanupAudio()
    mediaRecorderRef.current = null
    chunksRef.current = []
    setElapsed(0)
  }, [cleanupAudio])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup()
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current)
      }
    }
  }, [cleanup])

  const start = useCallback(async () => {
    if (state !== 'idle') return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Set up audio analysis for volume metering
      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)

      const dataArray = new Uint8Array(analyser.fftSize)
      const updateVolume = () => {
        analyser.getByteTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / dataArray.length)
        const vol = Math.min(1, rms * 2)
        if (vol > peakVolumeRef.current) peakVolumeRef.current = vol
        setVolume(vol)
        rafIdRef.current = requestAnimationFrame(updateVolume)
      }
      rafIdRef.current = requestAnimationFrame(updateVolume)

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'

      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        const wasCancelled = cancelledRef.current
        cancelledRef.current = false
        const blob = new Blob(chunksRef.current, { type: mimeType })
        const shouldAutoSend = autoSendRef.current
        autoSendRef.current = false

        // Stop tracks, clear timer, clean up audio
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop())
          streamRef.current = null
        }
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
        cleanupAudio()

        // Skip cancelled, empty, too-short (< 300ms), or silent recordings
        const duration = Date.now() - recordingStartRef.current
        if (wasCancelled || blob.size === 0 || duration < 300 || peakVolumeRef.current < 0.05) {
          setState('idle')
          setElapsed(0)
          return
        }

        setState('transcribing')

        try {
          const result = await transcribe(blob)
          if (result.text.trim()) {
            if (shouldAutoSend && onAutoSend) {
              onAutoSend(result.text.trim())
            } else {
              onTranscription(result.text.trim())
            }
          }
        } catch {
          onError?.('Transcription failed, please try again')
        } finally {
          setState('idle')
          setElapsed(0)
        }
      }

      recorder.start()
      recordingStartRef.current = Date.now()
      peakVolumeRef.current = 0
      setState('recording')
      setElapsed(0)

      // Start elapsed timer
      const startTime = Date.now()
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000))
      }, 1000)
    } catch {
      onError?.('Microphone access denied')
      cleanup()
      setState('idle')
    }
  }, [state, transcribe, onTranscription, onAutoSend, onError, cleanup, cleanupAudio])

  const stop = useCallback(() => {
    if (state !== 'recording' || !mediaRecorderRef.current) return
    mediaRecorderRef.current.stop()
  }, [state])

  const stopAndSend = useCallback(() => {
    if (state !== 'recording' || !mediaRecorderRef.current) return
    autoSendRef.current = true
    mediaRecorderRef.current.stop()
  }, [state])

  const cancel = useCallback(() => {
    if (state !== 'recording' || !mediaRecorderRef.current) return
    cancelledRef.current = true
    mediaRecorderRef.current.stop()
  }, [state])

  // Press tracking functions for tap-toggle vs hold-to-talk
  const beginPress = useCallback(() => {
    if (disabled || state === 'transcribing') return
    pressStartRef.current = Date.now()
    wasRecordingOnPressRef.current = state === 'recording'
    holdCancelledRef.current = false

    if (state !== 'recording') {
      start()
    }

    holdTimerRef.current = setTimeout(() => {
      setIsHoldMode(true)
    }, 300)
  }, [disabled, state, start])

  const endPress = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }

    if (isHoldMode) {
      if (!holdCancelledRef.current && state === 'recording') {
        stopAndSend()
      }
      setIsHoldMode(false)
    } else {
      // Tap: only stop if recording was already active before this press
      if (wasRecordingOnPressRef.current && state === 'recording') {
        stop()
      }
    }
    pressStartRef.current = 0
  }, [isHoldMode, state, stop, stopAndSend])

  const cancelPress = useCallback(() => {
    if (state === 'recording') {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
      holdCancelledRef.current = true
      setIsHoldMode(false)
      cancel()
      pressStartRef.current = 0
    }
  }, [state, cancel])

  // Helper to check if a press is active (for keyboard handling)
  const isPressing = useCallback(() => pressStartRef.current > 0, [])

  return {
    state,
    elapsed,
    volume,
    isSupported,
    isHoldMode,
    start,
    stop,
    stopAndSend,
    cancel,
    // Press tracking for mouse/touch/keyboard
    beginPress,
    endPress,
    cancelPress,
    isPressing,
  }
}
