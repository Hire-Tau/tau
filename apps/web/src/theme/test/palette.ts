import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'

/** Real built-in definitions, not a second runtime palette. */
const css = postcss.parse(readFileSync(join(import.meta.dir, '../../index.css'), 'utf8'))
export const variants: Record<'light' | 'dark', Record<string, string>> = { light: {}, dark: {} }
for (const [variant, selector] of [
  ['light', ':root'],
  ['dark', '.dark'],
] as const) {
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return
    rule.walkDecls((decl) => {
      variants[variant][decl.prop] = decl.value
    })
  })
}

export function channelsToHex(channels: string): string {
  return (
    '#' +
    channels
      .split(/\s+/)
      .map((v) => Number(v).toString(16).padStart(2, '0'))
      .join('')
  )
}

function luminance(hex: string): number {
  const rgb = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!
}
export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg),
    b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
