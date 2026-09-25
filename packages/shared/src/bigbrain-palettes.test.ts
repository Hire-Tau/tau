import { describe, expect, test } from 'bun:test'
import { BIGBRAIN_PALETTES, mixSrgb } from './bigbrain-palettes'

describe('BIGBRAIN_PALETTES', () => {
  test('has six entries with unique ids and non-empty base colors', () => {
    expect(BIGBRAIN_PALETTES).toHaveLength(6)
    expect(new Set(BIGBRAIN_PALETTES.map((p) => p.id)).size).toBe(6)
    for (const palette of BIGBRAIN_PALETTES) {
      expect(palette.bg).toMatch(/^#[0-9a-f]{6}$/)
      expect(palette.fg).toMatch(/^#[0-9a-f]{6}$/)
      expect(palette.activity).toMatch(/^#[0-9a-f]{6}$/)
      expect(['light', 'dark']).toContain(palette.scheme)
    }
  })
})

describe('mixSrgb', () => {
  test('mixes two sRGB colors by percentage', () => {
    expect(mixSrgb('#000000', 50, '#ffffff')).toBe('#808080')
    expect(mixSrgb('#000000', 0, '#ffffff')).toBe('#ffffff')
    expect(mixSrgb('#000000', 100, '#ffffff')).toBe('#000000')
  })

  test('rounds fractional channels', () => {
    // 25% of #ff0000 into #000000 -> channel 0.25*255 = 63.75 -> rounds to 64 = 0x40
    expect(mixSrgb('#ff0000', 25, '#000000')).toBe('#400000')
  })

  test('clamps out-of-range percentages', () => {
    expect(mixSrgb('#112233', 150, '#ffffff')).toBe(mixSrgb('#112233', 100, '#ffffff'))
    expect(mixSrgb('#112233', -10, '#ffffff')).toBe(mixSrgb('#112233', 0, '#ffffff'))
  })
})
