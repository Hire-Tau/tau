import { useQuery } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import type { VoiceStatus } from '../api/voice'

/** Show voice only after configuration is confirmed; retain cached capability on refresh failures. */
export function voiceEnabledFromQuery(result: { data?: VoiceStatus; isError: boolean }): boolean {
  return result.data?.enabled === true && result.data.transcriptionEnabled !== false
}

/** Whether voice dictation is configured and enabled. */
export function useVoiceEnabled(): boolean {
  const { data, isError } = useQuery(queries.voice.status())
  return voiceEnabledFromQuery({ data, isError })
}

/** Realtime can be turned off independently of transcription. */
export function useRealtimeEnabled(): boolean {
  const { data } = useQuery(queries.voice.status())
  return data?.enabled === true && data.realtimeEnabled !== false
}
