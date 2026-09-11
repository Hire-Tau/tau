import { useEffect, type RefObject } from 'react'
import type { RecorderState } from './useVoiceRecorder'
import type { FormFillState } from './useVoiceFormFill'

interface UseVoiceKeyboardShortcutsOptions {
  /** Whether shortcuts are enabled */
  enabled: boolean
  /** Only handle shortcuts originating inside this composer or question form. */
  scopeRef?: RefObject<HTMLElement | null>
  /** Current recorder state */
  voiceState: RecorderState
  /** Whether voice recording is supported */
  isSupported: boolean
  /** Whether input has content (disables Arrow Up shortcut) */
  hasInput: boolean
  /** Whether input is disabled */
  disabled: boolean
  /** Start recording */
  start: () => void
  /** Stop recording (transcribe to input) */
  stop: () => void
  /** Stop and auto-send (transcribe and submit) */
  stopAndSend: () => void
  /** Cancel recording */
  cancel: () => void
  /** Begin press (for Ctrl+Shift+V hold-to-talk) */
  beginPress: () => void
  /** End press (for Ctrl+Shift+V release) */
  endPress: () => void
  /** Check if press is active */
  isPressing: () => boolean
  /** Callback when Escape is pressed and not recording */
  onEscape?: () => void
  /** Form fill voice (Alt+ArrowUp) */
  formFill?: {
    state: FormFillState
    beginPress: () => void
    endPress: () => void
    cancel: () => void
    isPressing: () => boolean
  }
}

export function useVoiceKeyboardShortcuts({
  enabled,
  scopeRef,
  voiceState,
  isSupported,
  hasInput,
  disabled,
  start,
  stop,
  stopAndSend,
  cancel,
  beginPress,
  endPress,
  isPressing,
  onEscape,
  formFill,
}: UseVoiceKeyboardShortcutsOptions) {
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (scopeRef) {
        const scope = scopeRef.current
        if (!scope || scope.closest('[hidden], [inert]') || !(e.target instanceof Node) || !scope.contains(e.target))
          return
      }
      // Escape: cancel form fill recording, then description recording, then close
      if (e.key === 'Escape') {
        if (formFill?.state === 'recording') {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          formFill.cancel()
          return
        }
        if (voiceState === 'recording') {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation()
          cancel()
          return
        }
        if (onEscape) {
          e.preventDefault()
          e.stopPropagation()
          onEscape()
        }
        return
      }

      // Skip other voice shortcuts if not supported
      if (!isSupported) return

      // Alt+ArrowUp: form fill voice (start or stop)
      if (
        e.key === 'ArrowUp' &&
        e.altKey &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey &&
        formFill &&
        !disabled
      ) {
        e.preventDefault()
        if (formFill.state === 'recording') {
          formFill.endPress()
        } else if (formFill.state === 'idle') {
          formFill.beginPress()
        }
        return
      }

      // Ctrl+Shift+V: hold-to-talk
      if (e.ctrlKey && e.shiftKey && (e.key === 'v' || e.key === 'V') && !e.metaKey && !e.altKey && !disabled) {
        e.preventDefault()
        if (e.repeat) return
        beginPress()
        return
      }

      // ArrowUp: start recording (idle) or stop & auto-send (recording)
      if (
        e.key === 'ArrowUp' &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.altKey &&
        !hasInput &&
        !disabled
      ) {
        e.preventDefault()
        if (voiceState === 'recording') {
          stopAndSend()
        } else if (voiceState === 'idle') {
          start()
        }
        return
      }

      // ArrowDown: stop recording & preview in input (no auto-send)
      if (
        e.key === 'ArrowDown' &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.altKey &&
        voiceState === 'recording'
      ) {
        e.preventDefault()
        stop()
        return
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if ((e.key === 'v' || e.key === 'V') && isPressing()) {
        endPress()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('keyup', handleKeyUp)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('keyup', handleKeyUp)
    }
  }, [
    enabled,
    scopeRef,
    voiceState,
    isSupported,
    hasInput,
    disabled,
    start,
    stop,
    stopAndSend,
    cancel,
    beginPress,
    endPress,
    isPressing,
    onEscape,
    formFill,
  ])
}
