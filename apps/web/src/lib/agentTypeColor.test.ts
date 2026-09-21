import { describe, expect, it } from 'bun:test'
import { AGENT_TYPE_COLOR_PALETTE, agentTypeColor } from './agentTypeColor'
import { channelsToHex, contrastRatio, variants } from '../theme/test/palette'

describe('agentTypeColor', () => {
  it('is deterministic, varied, and muted when absent', () => {
    expect(agentTypeColor('engineer')).toBe(agentTypeColor('engineer'))
    expect(new Set(['manager', 'engineer', 'reviewer', 'architect'].map(agentTypeColor)).size).toBeGreaterThan(1)
    expect(agentTypeColor(null)).toContain('muted')
  })

  it('resolves every palette slot to its original colors and preserves WCAG AA contrast', () => {
    const original = [
      ['#6d28d9', '#c4b5fd'],
      ['#1d4ed8', '#93c5fd'],
      ['#047857', '#6ee7b7'],
      ['#92400e', '#fcd34d'],
      ['#be123c', '#fda4af'],
      ['#155e75', '#67e8f9'],
    ]
    AGENT_TYPE_COLOR_PALETTE.forEach((entry, i) => {
      expect(entry.className).toBe(`text-agent-type-${i + 1}`)
      for (const [variant, column, baseline] of [
        ['light', 0, '#ffffff'],
        ['dark', 1, '#0f172a'],
      ] as const) {
        const fg = channelsToHex(variants[variant][entry.token]!)
        expect(fg).toBe(original[i]![column]!)
        expect(contrastRatio(fg, baseline)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(fg, channelsToHex(variants[variant]['--color-bg-surface']!))).toBeGreaterThanOrEqual(4.5)
      }
    })
  })

  it('keeps six distinct colors in both appearances', () => {
    for (const variant of Object.values(variants)) {
      expect(new Set(AGENT_TYPE_COLOR_PALETTE.map(({ token }) => variant[token])).size).toBe(6)
    }
  })
})
