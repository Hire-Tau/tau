import { describe, expect, it } from 'bun:test'
import { AGENT_TYPE_COLOR_PALETTE, agentTypeColor } from './agentTypeColor'

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

const tailwindHex: Record<string, string> = {
  'text-violet-700': '#6d28d9',
  'dark:text-violet-300': '#c4b5fd',
  'text-blue-700': '#1d4ed8',
  'dark:text-blue-300': '#93c5fd',
  'text-emerald-700': '#047857',
  'dark:text-emerald-300': '#6ee7b7',
  'text-amber-800': '#92400e',
  'dark:text-amber-300': '#fcd34d',
  'text-rose-700': '#be123c',
  'dark:text-rose-300': '#fda4af',
  'text-cyan-800': '#155e75',
  'dark:text-cyan-300': '#67e8f9',
}

describe('agentTypeColor', () => {
  it('is deterministic, varied, and muted when absent', () => {
    expect(agentTypeColor('engineer')).toBe(agentTypeColor('engineer'))
    expect(new Set(['manager', 'engineer', 'reviewer', 'architect'].map(agentTypeColor)).size).toBeGreaterThan(1)
    expect(agentTypeColor(null)).toContain('muted')
  })

  it('meets WCAG AA contrast for small text on light and dark surfaces', () => {
    for (const color of AGENT_TYPE_COLOR_PALETTE) {
      const [lightClass, darkClass] = color.className.split(' ')
      expect(tailwindHex[lightClass]).toBe(color.lightHex)
      expect(tailwindHex[darkClass]).toBe(color.darkHex)
      expect(contrastRatio(color.lightHex, '#ffffff')).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(color.darkHex, '#0f172a')).toBeGreaterThanOrEqual(4.5)
    }
  })
})
