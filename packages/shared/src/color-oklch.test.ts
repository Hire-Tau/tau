import { describe, expect, test } from 'bun:test'
import { oklchToSrgb, srgbToOklch } from './color-oklch'

describe('sRGB <-> OKLCH', () => {
  test('white and black are achromatic fixed points', () => {
    const white = srgbToOklch([255, 255, 255])
    expect(white.l).toBeCloseTo(1, 2)
    expect(white.c).toBeCloseTo(0, 2)
    const black = srgbToOklch([0, 0, 0])
    expect(black.l).toBeCloseTo(0, 2)
    expect(black.c).toBeCloseTo(0, 2)
  })

  test('mid-gray has zero chroma and round-trips exactly', () => {
    const gray = srgbToOklch([128, 128, 128])
    expect(gray.c).toBeCloseTo(0, 2)
    const [r, g, b] = oklchToSrgb(gray)
    expect(r).toBe(128)
    expect(g).toBe(128)
    expect(b).toBe(128)
  })

  test('pure red converts to a known approximate OKLCH triple', () => {
    // Reference values from the public OKLCH reference implementation (Björn Ottosson).
    const red = srgbToOklch([255, 0, 0])
    expect(red.l).toBeCloseTo(0.628, 2)
    expect(red.c).toBeCloseTo(0.2577, 2)
    expect(red.h).toBeCloseTo(29.23, 0)
  })

  test('round trip recovers the original channels within rounding tolerance', () => {
    const samples: Array<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [91, 33, 182],
      [14, 95, 109],
      [151, 55, 29],
      [10, 20, 30],
      [250, 240, 230],
    ]
    for (const rgb of samples) {
      const [r, g, b] = oklchToSrgb(srgbToOklch(rgb))
      expect(Math.abs(r - rgb[0])).toBeLessThanOrEqual(1)
      expect(Math.abs(g - rgb[1])).toBeLessThanOrEqual(1)
      expect(Math.abs(b - rgb[2])).toBeLessThanOrEqual(1)
    }
  })

  test('output channels are always clamped to valid 0-255 integers', () => {
    // An extreme lightness/chroma combination that maps outside sRGB gamut.
    const [r, g, b] = oklchToSrgb({ l: 1.5, c: 0.5, h: 30 })
    for (const channel of [r, g, b]) {
      expect(Number.isInteger(channel)).toBe(true)
      expect(channel).toBeGreaterThanOrEqual(0)
      expect(channel).toBeLessThanOrEqual(255)
    }
  })
})
