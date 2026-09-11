import { describe, expect, test } from 'bun:test'
import type { StatusRole } from '@tau/shared'
import { WEB_STATUS, webStatus } from './statusPresentation'

const expected = {
  progress: ['blue', '#3b82f6', '#1d4ed8', '#60a5fa'],
  queue: ['cyan', '#06b6d4', '#0e7490', '#22d3ee'],
  review: ['yellow', '#eab308', '#a16207', '#facc15'],
  humanWait: ['purple', '#a855f7', '#7e22ce', '#c084fc'],
  externalWait: ['orange', '#f97316', '#c2410c', '#fb923c'],
  attention: ['amber', '#f59e0b', '#b45309', '#fbbf24'],
  danger: ['red', '#ef4444', '#b91c1c', '#f87171'],
  success: ['green', '#22c55e', '#15803d', '#4ade80'],
  neutral: ['gray', '#6b7280', '#4b5563', '#9ca3af'],
} as const satisfies Record<StatusRole, readonly [string, string, string, string]>

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

describe('web status presentation', () => {
  test('provides the exact treatment for every role', () => {
    expect(Object.keys(WEB_STATUS).sort()).toEqual(Object.keys(expected).sort())
    for (const [role, [color, markerHex]] of Object.entries(expected) as Array<
      [StatusRole, (typeof expected)[StatusRole]]
    >) {
      expect(webStatus(role)).toEqual({
        markerClass: `bg-${color}-500`,
        markerHex,
        textClass: `text-${color}-700 dark:text-${color}-400`,
        surfaceClass: `bg-${color}-50 dark:bg-${color}-900/20`,
        borderClass: `border-${color}-200 dark:border-${color}-800`,
        badgeColor: color,
      })
    }
  })

  test('light foregrounds meet WCAG AA contrast for small text', () => {
    for (const [, , lightForeground] of Object.values(expected)) {
      expect(contrastRatio(lightForeground, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    }
  })
})
