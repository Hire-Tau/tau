import { apiFetch } from './client'

export interface VoiceStatus {
  /** True when the server has an OpenAI API key configured. */
  enabled: boolean
  realtimeEnabled?: boolean
}

export const getVoiceStatus = () => apiFetch<VoiceStatus>('/voice/status')
