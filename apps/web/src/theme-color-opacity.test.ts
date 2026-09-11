import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The `th-*` theme colors in tailwind.config.js are plain `var(--color-*)` references
// with no `<alpha-value>` channel form, so Tailwind v3 cannot apply an opacity
// modifier to them: `divide-th-border/50` produces NO rule at all, and the border
// silently falls back to preflight's default (#e5e7eb) — invisible on the light
// theme, a bright white line on the dark one (inbox separators, 2026-09-11).
// Either use the color unmodified or convert the token to the channel form.
const THEME_COLOR_WITH_OPACITY = /-th-[a-z-]+\/\d+\b/g

const srcRoot = join(import.meta.dir)

describe('tailwind theme colors', () => {
  test('th-* colors are never used with an opacity modifier', () => {
    const offenders: string[] = []
    for (const path of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: srcRoot })) {
      if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue
      const source = readFileSync(join(srcRoot, path), 'utf8')
      source.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(THEME_COLOR_WITH_OPACITY)) {
          offenders.push(`${path}:${index + 1} ${match[0]}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
