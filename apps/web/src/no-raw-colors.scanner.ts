/**
 * Raw-color detector for apps/web/src (phase 1 guard).
 *
 * Finds the four categories of un-tokenized color use documented in the
 * research report §2.4/§9 (artifact: artifacts/color-theme-investigation):
 *
 *   1. Tailwind palette utilities (bg-<palette>-<step>, text-<palette>-<step>, …)
 *   2. Literal hex colors
 *   3. rgb()/hsl()-style color functions with non-token arguments
 *      (a `rgb(var(--color-border))` channel wrapper is the sanctioned token
 *      form and is NOT a violation; a call with a JS template interpolation
 *      is dynamic construction, not a literal, and is likewise out of scope)
 *   4. color-bearing inline style objects
 *
 * The scanner is intentionally dependency-free and pure so the guard test and
 * the detector's own unit tests share one implementation.
 */

export type RawColorCategory = 'palette-utility' | 'literal-hex' | 'color-function' | 'inline-color-style'

export interface RawColorFinding {
  readonly category: RawColorCategory
  readonly path: string
  readonly line: number
  readonly match: string
}

const TAILWIND_PALETTE_NAMES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'

/** Tailwind palette utilities, e.g. bg-<palette>-50, dark:text-<palette>-700, md:bg-<palette>-500/30. */
export const PALETTE_UTILITY_PATTERN = new RegExp(
  `(?<![\\w-])(?:[a-zA-Z-]+:)*(bg|text|border|ring|outline|divide|from|via|to|fill|stroke|shadow|accent|placeholder|decoration|caret)-(${TAILWIND_PALETTE_NAMES})-(50|[1-9]00|950)(?:\\/[\\d.]+)?\\b`,
  'g'
)

/** Literal hex colors: #rgb, #rgba, #rrggbb, #rrggbbaa. */
export const LITERAL_HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/g

/** Color functions whose arguments are not pure token references. */
export const COLOR_FUNCTION_PATTERN = /\b(rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix)\(/g

/** JSX inline style props that can carry colors (camelCase React style keys). */
export const INLINE_COLOR_PROP_PATTERN =
  /\b(backgroundColor|background|borderColor|color|fill|stroke|boxShadow|outlineColor|textDecorationColor|caretColor|accentColor|columnRuleColor)\s*:/

const STYLE_OBJECT_START = /style\s*=\s*\{/g

/** Splits on a single-character separator at paren/bracket/brace depth zero. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') depth--
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** Extracts the balanced-parenthesis argument text starting at the '(' index. */
function balancedArguments(source: string, openIndex: number): string {
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i]!
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) return source.slice(openIndex + 1, i)
    }
  }
  return source.slice(openIndex + 1)
}

const NESTED_COLOR_FUNCTION = /^(rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix)\s*\(/

/**
 * True when a comma-part of a color function is a pure token reference:
 * var(--…), a var with an alpha modifier, transparent/currentColor/none, a
 * color-mix interpolation space (e.g. "in srgb"), or a nested color function
 * that itself only contains token references. Bare numbers (literal channels
 * like `156 163 175`) are NOT token references.
 */
function colorPartIsTokenOnly(rawPart: string): boolean {
  let part = rawPart.trim()
  if (part === '') return true
  // color-mix interpolation space hint: "in srgb", "in oklab", …
  part = part.replace(/^in\s+[a-z-]+(?:\s+[a-z-]+)?\s*/, '').trim()
  if (part === '') return true
  if (part === 'transparent' || part === 'currentColor' || part === 'none') return true
  if (part.startsWith('var(') && balancedArguments(part, 3).length + 5 === part.length) {
    const [name, ...fallback] = splitTopLevel(balancedArguments(part, 3), ',')
    if (/^--[\w-]+$/.test(name!.trim())) return !fallback.length || colorPartIsTokenOnly(fallback.join(','))
  }
  // color-mix amount suffix: "<color> 35%"
  const percentSuffix = /^(.*)\s+[\d.]+%$/.exec(part)
  if (percentSuffix) return colorPartIsTokenOnly(percentSuffix[1]!)
  // modern alpha syntax: "<color> / 50%" or "<color> / 0.5"
  const alphaParts = splitTopLevel(part, '/')
  if (alphaParts.length === 2) {
    const head = alphaParts[0]!.trim()
    const tail = alphaParts[1]!.trim()
    const alpha = tail.replace(/var\(--[\w-]+(?:,\s*[\d.]+)?\)/g, '1')
    if (/^[\d.]+%?$/.test(alpha) || /^calc\([\d.\s*]+\)$/.test(alpha)) return colorPartIsTokenOnly(head)
  }
  const nested = NESTED_COLOR_FUNCTION.exec(part)
  if (nested) {
    const inner = balancedArguments(part, part.indexOf('('))
    return splitTopLevel(inner, ',').every((sub) => colorPartIsTokenOnly(sub))
  }
  return false
}

/** True when the color function call at the match index only references tokens. */
export function colorFunctionIsTokenOnly(source: string, parenIndex: number): boolean {
  const args = balancedArguments(source, parenIndex)
  // A JS template interpolation (rgb(`${channels}`)) constructs a color from
  // runtime values — typically a token read via getComputedStyle — so there is
  // no literal to guard against here.
  if (args.includes('${')) return true
  return splitTopLevel(args, ',').every((part) => colorPartIsTokenOnly(part))
}

/** Extracts a JSX style object body starting at the '{' after `style=`. */
function styleObjectBody(source: string, openBraceIndex: number): string | null {
  let depth = 0
  let inString: string | null = null
  for (let i = openBraceIndex; i < source.length; i++) {
    const char = source[i]!
    if (inString) {
      if (char === '\\') i++
      else if (char === inString) inString = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') inString = char
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return source.slice(openBraceIndex + 1, i)
    }
  }
  return null
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line++
  return line
}

/** Scans one source file (path relative to apps/web/src) for raw colors. */
export function scanSourceForRawColors(path: string, source: string): RawColorFinding[] {
  const findings: RawColorFinding[] = []

  for (const match of source.matchAll(PALETTE_UTILITY_PATTERN)) {
    findings.push({ category: 'palette-utility', path, line: lineOf(source, match.index!), match: match[0] })
  }
  for (const match of source.matchAll(LITERAL_HEX_PATTERN)) {
    findings.push({ category: 'literal-hex', path, line: lineOf(source, match.index!), match: match[0] })
  }
  for (const match of source.matchAll(COLOR_FUNCTION_PATTERN)) {
    const parenIndex = match.index! + match[0].length - 1
    if (colorFunctionIsTokenOnly(source, parenIndex)) continue
    findings.push({
      category: 'color-function',
      path,
      line: lineOf(source, match.index!),
      match: source
        .slice(match.index!, Math.min(source.indexOf('\n', match.index!) + 1, match.index! + 80) || match.index! + 80)
        .trim(),
    })
  }
  for (const match of source.matchAll(STYLE_OBJECT_START)) {
    const braceIndex = source.indexOf('{', match.index!)
    const body = styleObjectBody(source, braceIndex)
    if (body == null) continue
    const colorProp = INLINE_COLOR_PROP_PATTERN.exec(body)
    if (colorProp) {
      findings.push({
        category: 'inline-color-style',
        path,
        line: lineOf(source, match.index!),
        match: `style={{ … ${colorProp[1]} … }}`,
      })
    }
  }

  return findings
}
