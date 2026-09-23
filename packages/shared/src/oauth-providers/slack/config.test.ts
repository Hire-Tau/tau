import { describe, expect, test } from 'bun:test'
import { parseSlackConfiguration, safeSlackConfiguration } from './config'

const valid = {
  version: 1 as const,
  teamId: 'T1234567890',
  teamName: 'Acme Corp',
  botUserId: 'U2222222222',
  appId: 'A1234567890',
}

describe('parseSlackConfiguration', () => {
  test('parses a valid configuration and strips no fields', () => {
    expect(parseSlackConfiguration(valid)).toEqual(valid)
  })

  test('accepts a null team name', () => {
    expect(parseSlackConfiguration({ ...valid, teamName: null }).teamName).toBeNull()
  })

  test('rejects unknown keys', () => {
    expect(() => parseSlackConfiguration({ ...valid, extra: 'x' })).toThrow()
  })

  test('rejects missing keys', () => {
    const { teamId: _teamId, ...rest } = valid
    expect(() => parseSlackConfiguration(rest)).toThrow()
  })

  test('rejects the wrong version', () => {
    expect(() => parseSlackConfiguration({ ...valid, version: 2 })).toThrow()
  })

  test('rejects non-object input', () => {
    expect(() => parseSlackConfiguration('nope')).toThrow()
    expect(() => parseSlackConfiguration(null)).toThrow()
  })
})

describe('safeSlackConfiguration', () => {
  test('exposes only teamId and teamName', () => {
    expect(safeSlackConfiguration(parseSlackConfiguration(valid))).toEqual({
      teamId: 'T1234567890',
      teamName: 'Acme Corp',
    })
  })
})
