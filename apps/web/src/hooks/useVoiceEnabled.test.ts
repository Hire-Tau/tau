import { describe, expect, test } from 'bun:test'
import { voiceEnabledFromQuery } from './useVoiceEnabled'

describe('voiceEnabledFromQuery', () => {
  test('shows the microphone when the server reports voice enabled', () => {
    expect(voiceEnabledFromQuery({ data: { enabled: true }, isError: false })).toBe(true)
  })

  test('hides the microphone when the server reports voice disabled', () => {
    expect(voiceEnabledFromQuery({ data: { enabled: false }, isError: false })).toBe(false)
  })

  test('hides the microphone while the capability is unknown, so it never flashes', () => {
    expect(voiceEnabledFromQuery({ data: undefined, isError: false })).toBe(false)
  })

  test('hides the microphone when configuration could not be confirmed', () => {
    expect(voiceEnabledFromQuery({ data: undefined, isError: true })).toBe(false)
  })

  test('a failed refresh does not hide a microphone that previously worked', () => {
    expect(voiceEnabledFromQuery({ data: { enabled: true }, isError: true })).toBe(true)
  })
})

test('a failed refresh does not expose voice on an unconfigured instance', () => {
  expect(voiceEnabledFromQuery({ data: { enabled: false }, isError: true })).toBe(false)
})
