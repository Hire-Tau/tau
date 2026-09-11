import { useState, useCallback, useRef } from 'react'
import { useVoiceRecorder } from './useVoiceRecorder'
import { transcribeAudio } from '../api/transcribe'
import { extractFormFields, type ExtractField } from '../api/extract'

export type FormFillState = 'idle' | 'recording' | 'transcribing' | 'extracting'

interface UseVoiceFormFillOptions {
  fields: Record<string, ExtractField>
  context?: string
  onResult: (values: Record<string, unknown>) => void
  onError: (error: string) => void
  disabled?: boolean
}

export function useVoiceFormFill({ fields, context, onResult, onError, disabled }: UseVoiceFormFillOptions) {
  const [extracting, setExtracting] = useState(false)
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields
  const contextRef = useRef(context)
  contextRef.current = context

  const handleTranscription = useCallback(
    async (text: string) => {
      setExtracting(true)
      try {
        const result = await extractFormFields({
          transcript: text,
          fields: fieldsRef.current,
          context: contextRef.current,
        })
        onResult(result.fields)
      } catch {
        onError('Failed to extract form fields')
      } finally {
        setExtracting(false)
      }
    },
    [onResult, onError]
  )

  const handleError = useCallback(
    (error: string) => {
      onError(error)
    },
    [onError]
  )

  const recorder = useVoiceRecorder({
    onTranscription: handleTranscription,
    onError: handleError,
    transcribe: transcribeAudio,
    disabled: disabled || extracting,
  })

  // Composite state: recorder state + extracting
  const state: FormFillState = extracting ? 'extracting' : recorder.state

  return {
    state,
    elapsed: recorder.elapsed,
    volume: recorder.volume,
    isSupported: recorder.isSupported,
    isHoldMode: recorder.isHoldMode,
    start: recorder.start,
    stop: recorder.stop,
    stopAndSend: recorder.stopAndSend,
    cancel: recorder.cancel,
    beginPress: recorder.beginPress,
    endPress: recorder.endPress,
    cancelPress: recorder.cancelPress,
    isPressing: recorder.isPressing,
  }
}
