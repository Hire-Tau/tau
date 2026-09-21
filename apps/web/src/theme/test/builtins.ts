import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { BUILT_IN_THEMES } from '../registry'
import { readTokenColor } from '../tokenReader'

export interface Palette {
  id: string
  appearance: 'light' | 'dark' | 'constant'
  selector: string
  tokens: Record<string, string>
}
export const palettes: Palette[] = BUILT_IN_THEMES.flatMap((theme) =>
  (theme.kind === 'unified' ? (['constant'] as const) : (['light', 'dark'] as const)).map((appearance) => {
    const selector =
      theme.id === 'tau'
        ? appearance === 'dark'
          ? '.dark'
          : ':root'
        : `:root[data-theme="${theme.id}"]${appearance === 'constant' ? '' : `[data-appearance="${appearance}"]`}`
    const css = postcss.parse(
      readFileSync(new URL(theme.id === 'tau' ? '../../index.css' : '../builtins.css', import.meta.url), 'utf8')
    )
    const tokens: Record<string, string> = {}
    css.walkRules((rule) => {
      if (rule.selector.replaceAll("'", '"') !== selector) return
      rule.walkDecls((decl) => {
        tokens[decl.prop] = decl.value
      })
    })
    return { id: theme.id, appearance, selector, tokens }
  })
)

export function resolveToken(tokens: Record<string, string>, token: string, seen: string[] = []): string {
  if (seen.includes(token)) throw new Error(`Cyclic token: ${token}`)
  const value = tokens[token]
  if (value === undefined) throw new Error(`Missing token: ${token}`)
  return value.replace(/var\((--[\w-]+)\)/g, (_, alias) => resolveToken(tokens, alias, [...seen, token]))
}
export function tokenRgba(tokens: Record<string, string>, token: string): number[] {
  const value = readTokenColor({ getPropertyValue: (name) => (tokens[name] ? resolveToken(tokens, name) : '') }, token)
  if (!value) throw new Error(`Not a color: ${token}`)
  return value.match(/[\d.]+/g)!.map(Number)
}
export function composite(fg: number[], bg: number[]): number[] {
  const alpha = fg[3] ?? 1
  return fg.slice(0, 3).map((v, i) => v * alpha + bg[i]! * (1 - alpha))
}
export function contrast(fg: number[], bg: number[]): number {
  const luminance = (rgb: number[]) =>
    rgb
      .slice(0, 3)
      .map((c) => c / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
  const a = luminance(composite(fg, bg)),
    b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
export interface ContrastPair {
  fg: string
  bg: string
  minimum: number
  under?: string
}
export const contrastPairs: ContrastPair[] = []
const add = (fg: string, bg: string, minimum = 4.5, under?: string) => contrastPairs.push({ fg, bg, minimum, under })
const surfaces = ['page', 'surface', 'surface-secondary', 'pill', 'surface-hover', 'inset'].map(
  (slot) => `--color-bg-${slot}`
)
for (const bg of surfaces) {
  for (const slot of ['primary', 'secondary', 'muted', 'placeholder']) add(`--color-text-${slot}`, bg)
  add('--color-focus', bg, 3)
  add('--scrollbar-thumb', bg, 3)
}
add('--color-code-text', '--color-code-bg')
for (const role of [
  'progress',
  'queue',
  'review',
  'human-wait',
  'external-wait',
  'attention',
  'danger',
  'success',
  'neutral',
]) {
  for (const under of surfaces) {
    add(`--status-${role}-fg`, `--status-${role}-surface`, 4.5, under)
    add(`--status-${role}-badge-fg`, `--status-${role}-badge-surface`, 4.5, under)
    add(`--status-${role}-badge-fg`, `--status-${role}-badge-hover`, 4.5, under)
  }
}
for (let i = 1; i <= 7; i++)
  for (const under of surfaces) {
    add(`--badge-accent-${i}-fg`, `--badge-accent-${i}-surface`, 4.5, under)
    add(`--badge-accent-${i}-fg`, `--badge-accent-${i}-hover`, 4.5, under)
  }
for (let i = 1; i <= 6; i++) for (const bg of surfaces) add(`--agent-type-${i}-fg`, bg)
for (const slot of [
  'fg',
  'comment',
  'keyword',
  'string',
  'number',
  'function',
  'punctuation',
  'operator',
  'variable',
  'property',
  'url',
]) {
  add(`--syntax-${slot}`, '--syntax-bg')
  add(`--syntax-${slot}`, '--syntax-memory-bg')
}
add('--syntax-human-code-fg', '--syntax-human-code-bg')
add('--term-fg', '--term-bg')
add('--term-muted', '--term-bg')
add('--term-cursor', '--term-bg', 3)
for (const bg of ['--color-primary', '--color-primary-hover', '--color-primary-active']) add('--on-accent-fg', bg)
add('--graph-label', '--graph-bg')
add('--graph-label-muted', '--graph-bg')
for (let i = 1; i <= 6; i++) add(`--graph-link-${i}`, '--graph-bg', 3)

export function pairRatio(tokens: Record<string, string>, pair: ContrastPair): number {
  const bg = composite(tokenRgba(tokens, pair.bg), tokenRgba(tokens, pair.under ?? '--color-bg-surface'))
  return contrast(tokenRgba(tokens, pair.fg), bg)
}
