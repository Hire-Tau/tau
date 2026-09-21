import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Root, type Rule } from 'postcss'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../tailwind.config.js'

// Regression history:
// 1. Plain var(--color-*) mappings silently emitted no rule for /50 utilities.
// 2. rgb(var(--token) / <alpha-value>) emitted rules, but tokens containing an
//    intrinsic alpha substituted to invalid rgb(R G B / intrinsic / requested).
// Both the actual generated rules AND their fully substituted values must be
// checked. Intrinsic opacity is multiplied by a modifier, never discarded.

const srcRoot = import.meta.dir
const sourceCss = postcss.parse(readFileSync(join(srcRoot, 'index.css'), 'utf8'))

function declarations(rule: Rule): Record<string, string> {
  const result: Record<string, string> = {}
  rule.each((node) => {
    if (node.type === 'decl') result[node.prop] = node.value
  })
  return result
}

function scopeVariables(selector: string): Record<string, string> {
  const scopes: Rule[] = []
  sourceCss.walkRules(selector, (rule) => {
    scopes.push(rule)
  })
  expect(scopes).toHaveLength(1)
  return declarations(scopes[0]!)
}

const scopes = {
  light: scopeVariables(':root'),
  dark: scopeVariables('.dark'),
}

/** Flatten Tailwind DEFAULT keys into the real utility name. */
function colorEntries(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]]
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    colorEntries(value, key === 'DEFAULT' ? prefix : [prefix, key].filter(Boolean).join('-'))
  )
}

const colors = colorEntries(tailwindConfig.theme.extend.colors)

async function compile(classes: string[]): Promise<Root> {
  const result = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: classes.join(' '), extension: 'html' }],
      plugins: [],
    }),
  ]).process('@tailwind utilities', { from: undefined })
  return result.root
}

/** Resolve the real scope variables, generated opacity variables and fallbacks. */
function substitute(value: string, variables: Record<string, string>): string {
  while (value.includes('var(')) {
    const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name: string, fallback?: string) => {
      const replacement = variables[name] ?? fallback
      if (replacement == null) throw new Error(`Missing ${name} in ${value}`)
      return replacement
    })
    if (next === value) throw new Error(`Unresolved or cyclic variable in ${value}`)
    value = next
  }
  // The adapter's only arithmetic is multiplication of two scalar alphas.
  // Reject anything else rather than silently accepting an unevaluated calc.
  return value.replace(/calc\(\s*([\d.]+)\s*\*\s*([\d.]+)\s*\)/g, (_, a: string, b: string) =>
    String(Number(a) * Number(b))
  )
}

/** Strict Color-4 numeric RGB grammar; double-alpha separators cannot pass. */
function numericRgb(value: string) {
  const match = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/.exec(value)
  if (!match) throw new Error(`Invalid fully substituted RGB color: ${value}`)
  const channels = match.slice(1, 4).map(Number)
  const alpha = Number(match[4])
  for (const channel of channels) {
    expect(channel).toBeGreaterThanOrEqual(0)
    expect(channel).toBeLessThanOrEqual(255)
  }
  expect(alpha).toBeGreaterThanOrEqual(0)
  expect(alpha).toBeLessThanOrEqual(1)
  return { channels, alpha }
}

function intrinsicAlpha(name: string, appearance: 'light' | 'dark') {
  if (name === 'panel-border') return 0.12
  if (name === 'input-border' && appearance === 'dark') return 0.16
  return 1
}

describe('tailwind theme color opacity after variable substitution', () => {
  test('every mapped color is channel-form with an opacity placeholder', () => {
    expect(colors.length).toBeGreaterThan(20)
    for (const [, mapping] of colors) {
      expect(mapping).toContain('<alpha-value>')
      expect(mapping).toMatch(/^rgb\(var\(--color-[a-z-]+\) \/ /)
      const token = /var\((--color-[a-z-]+)\)/.exec(mapping)![1]!
      // Audit ALL mappings: none may embed an alpha before the adapter adds it.
      for (const variables of Object.values(scopes)) {
        expect(variables[token]).toMatch(/^\d+ \d+ \d+$/)
      }
    }
  })

  test('the repaired token channels match the original translucent colors', () => {
    expect(scopes.light['--color-panel-border']).toBe('94 75 132')
    expect(scopes.dark['--color-panel-border']).toBe('190 181 215')
    expect(scopes.light['--color-input-border']).toBe('209 203 220')
    expect(scopes.dark['--color-input-border']).toBe('209 202 232')
  })

  test('the only remaining embedded-alpha tokens are unmapped CSS-only shadow/glass tokens', () => {
    const expected = ['--color-glass', '--color-shadow', '--color-shadow-lg']
    for (const variables of Object.values(scopes)) {
      const embeddedAlpha = Object.entries(variables)
        .filter(([name, value]) => name.startsWith('--color-') && value.includes('/'))
        .map(([name]) => name)
        .sort()
      expect(embeddedAlpha).toEqual(expected)
    }
  })

  test('all semantic utilities resolve to valid RGB, plain and modified, in BOTH appearances', async () => {
    const modifiers = ['', '/25', '/50', '/100']
    const expectedClasses = colors.flatMap(([name]) => modifiers.map((modifier) => `border-${name}${modifier}`))
    const generated = await compile(expectedClasses)
    const rules = new Map<string, Rule>()
    generated.walkRules((rule) => {
      // These generated selectors need only Tailwind's escaped slash removed.
      rules.set(rule.selector.replaceAll('\\', '').slice(1), rule)
    })
    expect([...rules.keys()].sort()).toEqual([...expectedClasses].sort())

    for (const [appearance, variables] of Object.entries(scopes) as Array<['light' | 'dark', Record<string, string>]>) {
      for (const [name, mapping] of colors) {
        const token = /var\((--color-[a-z-]+)\)/.exec(mapping)![1]!
        for (const modifier of modifiers) {
          const rule = rules.get(`border-${name}${modifier}`)!
          const declared = declarations(rule)
          const resolved = substitute(declared['border-color']!, { ...variables, ...declared })
          const { channels, alpha } = numericRgb(resolved)
          expect(channels).toEqual(variables[token]!.split(/\s+/).map(Number))
          const requestedOpacity = modifier ? Number(modifier.slice(1)) / 100 : 1
          expect(alpha).toBeCloseTo(intrinsicAlpha(name, appearance) * requestedOpacity, 8)
        }
      }
    }
  })

  test('the original double-alpha regression is rejected even though PostCSS emits a rule', () => {
    const substituted = substitute('rgb(var(--color-panel-border) / var(--tw-border-opacity, 1))', {
      '--color-panel-border': '94 75 132 / 0.12',
    })
    expect(substituted).toBe('rgb(94 75 132 / 0.12 / 1)')
    expect(() => numericRgb(substituted)).toThrow('Invalid fully substituted RGB')
  })

  test('direct CSS consumers retain the original panel/input alpha in both scopes', () => {
    // Audit every direct consumer, including borders, autofill and inset shadows.
    let consumers = 0
    for (const path of new Bun.Glob('**/*.css').scanSync({ cwd: srcRoot })) {
      const sheet = postcss.parse(readFileSync(join(srcRoot, path), 'utf8'))
      sheet.walkDecls((declaration) => {
        const matched = /var\(--color-(panel-border|input-border)\)/.exec(declaration.value)
        if (!matched) return
        consumers++
        const name = matched[1]!
        for (const [appearance, variables] of Object.entries(scopes) as Array<
          ['light' | 'dark', Record<string, string>]
        >) {
          const resolved = substitute(declaration.value, variables)
          const rgb = /rgb\([^()]+\)/.exec(resolved)
          expect(rgb).not.toBeNull()
          const { channels, alpha } = numericRgb(rgb![0])
          expect(channels).toEqual(variables[`--color-${name}`]!.split(/\s+/).map(Number))
          expect(alpha).toBeCloseTo(intrinsicAlpha(name, appearance), 8)
        }
      })
    }
    expect(consumers).toBe(6)
  })

  test('non-border opacity utilities still compile (including the original divide regression)', async () => {
    const compiled = (
      await compile(['bg-surface/50', 'divide-th-border/50', 'text-accent/70', 'ring-focus/30'])
    ).toString()
    expect(compiled).toContain('rgb(var(--color-bg-surface) / 0.5)')
    expect(compiled).toContain('rgb(var(--color-border) / 0.5)')
    expect(compiled).toContain('rgb(var(--color-primary) / 0.7)')
    expect(compiled).toContain('rgb(var(--color-focus) / 0.3)')
  })
})
