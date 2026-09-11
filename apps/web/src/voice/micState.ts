import type { RealtimeTransport } from './realtimeTransport'
import type { VoiceAssistantRuntime } from './useRealtimeVoiceAssistant'

const SYSTEM_MIC_DISABLE_SAFETY_TIMEOUT_MS = 20_000

export function createMicState(transportRef: { current: Pick<RealtimeTransport, 'setMicEnabled'> | null }) {
  let systemMicEnabled = true
  let userMicEnabled = true
  let systemMicSafetyTimeout: ReturnType<typeof setTimeout> | null = null

  const clearSystemMicSafetyTimeout = () => {
    if (systemMicSafetyTimeout) clearTimeout(systemMicSafetyTimeout)
    systemMicSafetyTimeout = null
  }

  const applyMicEnabled = () => {
    // Keep the WebRTC sender track alive during system-level suppression
    // (assistant speech, queued announcements, rate-limit waits). Firefox can
    // ICE-fail long sessions when the local audio track is disabled for tens of
    // seconds. Only explicit user mute physically disables the track.
    transportRef.current?.setMicEnabled(userMicEnabled)
  }

  const scheduleSystemMicSafetyTimeout = () => {
    clearSystemMicSafetyTimeout()
    systemMicSafetyTimeout = setTimeout(() => {
      systemMicSafetyTimeout = null
      if (systemMicEnabled || !userMicEnabled) return
      console.warn('[voice] system mic disable exceeded safety timeout; releasing system mic suppression')
      systemMicEnabled = true
      applyMicEnabled()
    }, SYSTEM_MIC_DISABLE_SAFETY_TIMEOUT_MS)
  }

  return {
    applyMicEnabled,
    setMicEnabled(enabled: boolean) {
      systemMicEnabled = enabled
      if (enabled) clearSystemMicSafetyTimeout()
      else scheduleSystemMicSafetyTimeout()
      applyMicEnabled()
    },
    setUserMicEnabled(enabled: boolean) {
      userMicEnabled = enabled
      applyMicEnabled()
    },
    getUserMicEnabled() {
      return userMicEnabled
    },
    markResponseInactive(runtime: Pick<VoiceAssistantRuntime<unknown>, 'markResponseActive'>) {
      runtime.markResponseActive(false)
      systemMicEnabled = true
      clearSystemMicSafetyTimeout()
      applyMicEnabled()
    },
    toggleMicMuted() {
      userMicEnabled = !userMicEnabled
      applyMicEnabled()
      return !userMicEnabled
    },
  }
}
