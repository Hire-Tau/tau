import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import { variants } from './test/palette'

const srcRoot = join(import.meta.dir, '..')
const css = postcss.parse(readFileSync(join(srcRoot, 'index.css'), 'utf8'))
function value(selector: string, property: string): string | undefined {
  let found: string | undefined
  css.walkRules(selector, (rule) => {
    rule.walkDecls(property, (decl) => {
      found = decl.value
    })
  })
  return found
}

describe('miscellaneous chrome tokens', () => {
  test('preserves checkbox colors and uses the approved contrast-safe scrollbars', () => {
    for (const tokens of Object.values(variants)) {
      expect(tokens['--checkbox-check']).toBe('255 255 255')
      expect(tokens['--on-accent-fg']).toBe('255 255 255')
    }
    expect(variants.light['--scrollbar-thumb']).toBe('55 65 81 / 0.65')
    expect(variants.dark['--scrollbar-thumb']).toBe('156 163 175 / 0.6')
    expect(value('.scrollbar-thin::-webkit-scrollbar-thumb', 'background-color')).toBe('rgb(var(--scrollbar-thumb))')
    expect(value(".dark input[type='checkbox']:checked::after", 'border')).toBe('solid rgb(var(--checkbox-check))')
  })
  test('selection intentionally uses the soft selection surface and readable primary text', () => {
    expect(value('::selection', 'background-color')).toBe('rgb(var(--color-selection-bg))')
    expect(value('::selection', 'color')).toBe('rgb(var(--color-text-primary))')
  })
  test('literal white does not return on directly token-driven accent fills', () => {
    for (const file of new Bun.Glob('**/*.tsx').scanSync({ cwd: srcRoot })) {
      if (file.includes('.test.') || file.includes('/test/')) continue
      const source = readFileSync(join(srcRoot, file), 'utf8')
      for (const literal of source.matchAll(/"[^"\n]*"|'[^'\n]*'/g)) {
        if (/\bbg-accent\b/.test(literal[0])) expect(`${file}: ${literal[0]}`).not.toContain('text-white')
      }
    }
    expect(readFileSync(join(srcRoot, 'design-system.css'), 'utf8')).toContain('color: rgb(var(--on-accent-fg))')
  })
})
