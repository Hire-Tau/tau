import { describe, expect, test } from 'bun:test'
import { ACTIVE_THEME_TOKENS, STATUS_TOKENS, THEME_TOKEN_NAMES } from './theme-schema'
import { compileCustomTheme, customColorChannels, validateCustomTheme } from './custom-theme'

const builtins = [
  { id: 'tau', label: 'Tau', kind: 'dual' as const },
  { id: 'high-contrast', label: 'High contrast', kind: 'unified' as const },
]
const doc = { format: 'tau-custom-theme', version: 1, name: 'My theme', base: 'tau', appearance: 'dark', overrides: {} }
const validate = (value: unknown) => validateCustomTheme(JSON.stringify(value), builtins)

describe('closed custom color grammar', () => {
  for (const [value, channels] of [
    ['#aBc', '170 187 204'],
    ['#0102ff', '1 2 255'],
    ['#01020300', '1 2 3 / 0'],
    ['#ffffff80', `255 255 255 / ${128 / 255}`],
    ['rgb(0, 128, 255)', '0 128 255'],
    ['rgba(1,2,3,.5)', '1 2 3 / 0.5'],
    ['rgba(1,2,3,1)', '1 2 3 / 1'],
  ] as const) {
    test(`accepts ${value}`, () => expect(customColorChannels(value)).toBe(channels))
  }
  for (const value of [
    null,
    1,
    {},
    [],
    '',
    '#12',
    '#1234',
    '#12345',
    '#gggggg',
    'red',
    'transparent',
    'none',
    'auto',
    '1 2 3',
    'var(--x)',
    'url(https://evil.test)',
    'color-mix(in srgb, red, blue)',
    'env(x)',
    'calc(1 + 2)',
    '#fff;',
    '#fff{}',
    '<style>',
    '#fff/*x*/',
    '#fff//x',
    'rgb(256,0,0)',
    'rgb(-1,0,0)',
    'rgb(1.1,2,3)',
    'rgb(10%,2,3)',
    'rgb(1 2 3)',
    'rgb(1,2,3,1)',
    'rgba(1,2,3)',
    'rgba(1,2,3,1.1)',
    'rgba(1,2,3,-1)',
    'rgba(1,2,3,50%)',
    'rgb(1e2,2,3)',
    'rgba(1,2,3,NaN)',
    '#fff\nurl(x)',
  ]) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      expect(customColorChannels(value)).toBeNull()
      expect(validate({ ...doc, overrides: { '--color-primary': value } }).ok).toBe(false)
    })
  }
})

test('required fields, types, version, base and concrete variant are enforced', () => {
  for (const key of Object.keys(doc)) {
    const broken = { ...doc } as Record<string, unknown>
    delete broken[key]
    expect(validate(broken).ok).toBe(false)
  }
  for (const value of [
    null,
    [],
    true,
    'text',
    { ...doc, name: '' },
    { ...doc, name: '   ' },
    { ...doc, name: 'x'.repeat(41) },
    { ...doc, base: '__proto__' },
    { ...doc, base: 'missing' },
    { ...doc, appearance: 'system' },
    { ...doc, appearance: 'constant' },
    { ...doc, base: 'high-contrast' },
    { ...doc, overrides: [] },
    { ...doc, overrides: null },
  ])
    expect(validate(value).ok).toBe(false)
  expect(validate({ ...doc, base: 'high-contrast', appearance: 'constant' }).ok).toBe(true)
  expect(validate({ ...doc, version: 2 })).toEqual({ ok: false, error: expect.stringContaining('version 1') })
  expect(validateCustomTheme('{broken', builtins).ok).toBe(false)
})

test('caps UTF-8 document bytes before parsing and override count before ignoring unknown names', () => {
  expect(validateCustomTheme(' '.repeat(8193), builtins).ok).toBe(false)
  const raw = JSON.stringify(doc)
  expect(validateCustomTheme(raw.padEnd(8192, ' '), builtins).ok).toBe(true)
  expect(validate({ ...doc, unused: 'é'.repeat(4100) }).ok).toBe(false)
  const overrides = Object.fromEntries(
    Array.from({ length: THEME_TOKEN_NAMES.length + 1 }, (_, i) => [`x${i}`, '#fff'])
  )
  expect(validate({ ...doc, overrides })).toEqual({ ok: false, error: 'Too many token overrides.' })
})

test('unknown/inactive names warn and cannot become properties, including prototype names', () => {
  const result = validateCustomTheme(
    JSON.stringify(doc).replace(
      '"overrides":{}',
      '"overrides":{"__proto__":"#fff","constructor":"#000","--future":"#abc","--brand-tile":"#def","--color-primary":"#123"}'
    ),
    builtins
  )
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.warnings).toHaveLength(4)
  expect(Object.keys(result.document.overrides)).toEqual(['--color-primary'])
  expect(validate({ ...doc, overrides: { '--future': 'url(x)' } }).ok).toBe(false)
})

test('status overrides are atomic BEFORE base inheritance; every activated family is accepted', () => {
  for (const token of STATUS_TOKENS) expect(validate({ ...doc, overrides: { [token]: '#fff' } }).ok).toBe(false)
  const status = Object.fromEntries(STATUS_TOKENS.map((token) => [token, '#fff']))
  expect(validate({ ...doc, overrides: status }).ok).toBe(true)
  for (const token of ACTIVE_THEME_TOKENS.filter((t) => !STATUS_TOKENS.includes(t)))
    expect(validate({ ...doc, overrides: { [token]: '#fff' } }).ok).toBe(true)
  expect(
    compileCustomTheme(
      JSON.stringify({ ...doc, overrides: { '--graph-bg': '#123', '--term-bg': 'rgba(1,2,3,0.5)' } }),
      builtins
    )
  ).toEqual({
    '--graph-bg': '17 34 51',
    '--term-bg': '1 2 3 / 0.5',
    '--custom-rgb-graph-bg': '17 34 51',
    '--custom-alpha-graph-bg': '1',
    '--custom-rgb-term-bg': '1 2 3',
    '--custom-alpha-term-bg': '0.5',
  })
  expect(() =>
    compileCustomTheme(JSON.stringify({ ...doc, overrides: { '--graph-bg': 'url(x)' } }), builtins)
  ).toThrow()
})
