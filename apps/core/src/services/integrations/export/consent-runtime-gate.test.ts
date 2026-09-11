import { expect, test } from 'bun:test'
import { isCurrentExportConsentAgent, isCurrentExportConsentConnection } from '../runtime'

test('consent connection must be the squad current assignment', () => {
  expect(isCurrentExportConsentConnection({ id: 'connection' }, 'connection')).toBe(true)
  expect(isCurrentExportConsentConnection({ id: 'other' }, 'connection')).toBe(false)
  expect(isCurrentExportConsentConnection(null, 'connection')).toBe(false)
})

test('current export consent agent must still be top-level in the requested squad', () => {
  expect(isCurrentExportConsentAgent({ squadId: 'squad', parentAgentId: null }, 'squad')).toBe(true)
  expect(isCurrentExportConsentAgent({ squadId: 'other', parentAgentId: null }, 'squad')).toBe(false)
  expect(isCurrentExportConsentAgent({ squadId: 'squad', parentAgentId: 'parent' }, 'squad')).toBe(false)
  expect(isCurrentExportConsentAgent(null, 'squad')).toBe(false)
})
