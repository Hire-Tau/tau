import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../tailwind.config.js'

// History: the semantic `th-*` theme colors used to be plain `var(--color-*)`
// references, so Tailwind v3 could not apply an opacity modifier —
// `divide-th-border/50` compiled to NO rule at all and the border silently
// fell back to preflight's default (inbox separators, 2026-09-11). The tokens
// are now RGB channel triplets and every semantic color in tailwind.config.js
// uses the `<alpha-value>` channel form, so opacity modifiers compile to real
// rules. This file pins both halves of that contract:
//
//   1. statically: token declarations stay channel-form and config entries
//      keep the `<alpha-value>` channel form (so a future addition can't
//      silently reintroduce the bug), and
//   2. functionally: opacity modifiers on semantic colors really compile to
//      rules (not nothing).

const srcRoot = join(import.meta.dir)
const css = readFileSync(join(srcRoot, 'index.css'), 'utf8')

/** Collects leaf color values from the Tailwind config's colors object. */
function collectColorEntries(node: unknown, prefix = '', entries: Array<[string, unknown]> = []) {
  if (typeof node === 'string') {
    entries.push([prefix, node])
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collectColorEntries(value, prefix ? `${prefix}-${key}` : key, entries)
    }
  }
  return entries
}

describe('tailwind theme colors', () => {
  test('every semantic color in tailwind.config.js uses the <alpha-value> channel form', () => {
    const entries = collectColorEntries((tailwindConfig.theme as { extend: { colors: unknown } }).extend.colors)
    expect(entries.length).toBeGreaterThan(20)
    const offenders = entries.filter(([, value]) => typeof value === 'string' && !value.includes('<alpha-value>'))
    expect(offenders).toEqual([])
  })

  test('every <alpha-value> color wraps a --color-* token with a color function', () => {
    const entries = collectColorEntries((tailwindConfig.theme as { extend: { colors: unknown } }).extend.colors)
    const offenders = entries
      .filter(
        ([, value]) => typeof value === 'string' && !/^rgb\(var\(--color-[a-z0-9-]+\) \/ <alpha-value>\)$/.test(value)
      )
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })

  test('token declarations in index.css stay channel-form (not full colors)', () => {
    // Full-color token values (hex, rgb()/rgba() literals) break the channel
    // form: `rgb(#fff / 0.5)` is invalid CSS. Channel triplets only.
    const offenders: string[] = []
    for (const match of css.matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const value = match[2]!.trim()
      if (value.startsWith('var(')) continue
      if (!/^\d{1,3}\s+\d{1,3}\s+\d{1,3}(\s*\/\s*(0?\.\d+|1|0))?$/.test(value)) {
        offenders.push(`${match[1]}: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('opacity modifiers on semantic colors compile to real rules', async () => {
    const content = [
      '<div class="bg-surface/50"></div>',
      '<div class="divide-th-border/50"></div>',
      '<div class="text-accent/70"></div>',
      '<div class="border-panel-border/25"></div>',
      '<div class="bg-page/40"></div>',
      '<div class="text-code-text/60"></div>',
      '<div class="ring-focus/30"></div>',
    ].join('\n')
    const { css: compiled } = await postcss([
      tailwindcss({
        ...tailwindConfig,
        // @ts-expect-error -- raw content entries are a supported Tailwind v3 shape
        content: [{ raw: content, extension: 'html' }],
        plugins: [],
      }),
    ]).process('@tailwind utilities', { from: undefined })

    // Each modifier must produce a rule that actually references the token
    // with the requested alpha — the exact failure mode of the old bug was
    // these utilities compiling to nothing.
    expect(compiled).toContain('rgb(var(--color-bg-surface) / 0.5)')
    expect(compiled).toContain('rgb(var(--color-border) / 0.5)')
    expect(compiled).toContain('rgb(var(--color-primary) / 0.7)')
    expect(compiled).toContain('rgb(var(--color-panel-border) / 0.25)')
    expect(compiled).toContain('rgb(var(--color-bg-page) / 0.4)')
    expect(compiled).toContain('rgb(var(--color-code-text) / 0.6)')
    expect(compiled).toContain('rgb(var(--color-focus) / 0.3)')
    expect(compiled).not.toContain('divide-th-border\\/50{--tw-divide-opacity')
  })

  test('unmodified semantic colors still compile (regression: channel form must not break plain usage)', async () => {
    const content = '<div class="bg-surface text-primary border-th-border bg-overlay"></div>'
    const { css: compiled } = await postcss([
      tailwindcss({
        ...tailwindConfig,
        // @ts-expect-error -- raw content entries are a supported Tailwind v3 shape
        content: [{ raw: content, extension: 'html' }],
        plugins: [],
      }),
    ]).process('@tailwind utilities', { from: undefined })
    expect(compiled).toContain('rgb(var(--color-bg-surface) / var(--tw-bg-opacity, 1))')
    expect(compiled).toContain('rgb(var(--color-text-primary) / var(--tw-text-opacity, 1))')
    expect(compiled).toContain('rgb(var(--color-border) / var(--tw-border-opacity, 1))')
  })
})
