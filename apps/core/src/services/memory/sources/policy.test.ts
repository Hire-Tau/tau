import { describe, expect, it } from 'bun:test'
import { validateBaseIngestionPolicy } from './policy'
import { FileSource } from './FileSource'
import { ThreadSource } from './ThreadSource'

describe('ingestion policy validation', () => {
  it('accepts base policy fields', () => {
    expect(
      validateBaseIngestionPolicy({
        version: 1,
        enabled: true,
        timeWindowDays: 7,
        minBytes: 0,
        retentionDays: 30,
        defaultSensitivity: 'internal',
      })
    ).toBeNull()
  })

  it('rejects invalid base policy values clearly', () => {
    expect(validateBaseIngestionPolicy({ version: 2, retentionDays: 0 })).toEqual(
      expect.arrayContaining([expect.stringContaining('version'), expect.stringContaining('retentionDays')])
    )
  })

  it('FileSource rejects non-string path scopes', () => {
    expect(FileSource.instance().validatePolicy?.({ version: 1, scope: { paths: [42] } })).toEqual([
      'scope.paths must be an array of strings',
    ])
  })

  it('ThreadSource rejects non-string agent type scopes', () => {
    expect(ThreadSource.instance().validatePolicy?.({ version: 1, scope: { agentTypes: [false] } })).toEqual([
      'scope.agentTypes must be an array of strings',
    ])
  })
})
