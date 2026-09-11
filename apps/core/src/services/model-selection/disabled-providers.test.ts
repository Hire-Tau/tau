import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getDisabledProviders, isProviderDisabled, setProviderEnabled } from './disabled-providers'
import { getSettingsStore, resetSettingsStore } from '../settings'
import { db, settings } from '../../db'

describe('disabled-providers', () => {
  beforeEach(async () => {
    await db.delete(settings)
    resetSettingsStore()
    const store = getSettingsStore()
    await store.initialize()
  })

  afterEach(() => {
    resetSettingsStore()
  })

  describe('getDisabledProviders / isProviderDisabled', () => {
    it('defaults to an empty set (all providers enabled)', () => {
      expect(getDisabledProviders()).toEqual(new Set())
      expect(isProviderDisabled('anthropic')).toBe(false)
    })

    it('reflects a disabled provider after disabling it', async () => {
      await setProviderEnabled('anthropic', false)
      expect(getDisabledProviders()).toEqual(new Set(['anthropic']))
      expect(isProviderDisabled('anthropic')).toBe(true)
      expect(isProviderDisabled('zai')).toBe(false)
    })
  })

  describe('setProviderEnabled', () => {
    it('disables a provider without touching credentials', async () => {
      await setProviderEnabled('zai', false)
      expect(isProviderDisabled('zai')).toBe(true)

      // Re-enabling removes it from the disabled set.
      await setProviderEnabled('zai', true)
      expect(isProviderDisabled('zai')).toBe(false)
      expect(getDisabledProviders()).toEqual(new Set())
    })

    it('re-enabling reuses the existing credential (disabled state is decoupled)', async () => {
      await setProviderEnabled('openai-codex', false)
      await setProviderEnabled('openai-codex', true)
      expect(isProviderDisabled('openai-codex')).toBe(false)
    })

    it('is idempotent', async () => {
      await setProviderEnabled('anthropic', false)
      await setProviderEnabled('anthropic', false)
      expect(getDisabledProviders()).toEqual(new Set(['anthropic']))
    })
  })
})
