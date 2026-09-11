import { useMemo } from 'react'

/**
 * ANSI escape code parser and renderer.
 * Converts terminal color codes to styled HTML spans.
 *
 * Supports:
 * - Reset (0)
 * - Bold (1), Dim (2), Underline (4)
 * - Standard foreground colors 30-37
 * - Bright foreground colors 90-97
 * - Standard background colors 40-47
 * - Bright background colors 100-107
 */

// ANSI color names for standard (30-37) and bright (90-97) colors
const FG_COLORS: Record<number, string> = {
  30: 'ansi-black',
  31: 'ansi-red',
  32: 'ansi-green',
  33: 'ansi-yellow',
  34: 'ansi-blue',
  35: 'ansi-magenta',
  36: 'ansi-cyan',
  37: 'ansi-white',
  90: 'ansi-bright-black',
  91: 'ansi-bright-red',
  92: 'ansi-bright-green',
  93: 'ansi-bright-yellow',
  94: 'ansi-bright-blue',
  95: 'ansi-bright-magenta',
  96: 'ansi-bright-cyan',
  97: 'ansi-bright-white',
}

const BG_COLORS: Record<number, string> = {
  40: 'ansi-bg-black',
  41: 'ansi-bg-red',
  42: 'ansi-bg-green',
  43: 'ansi-bg-yellow',
  44: 'ansi-bg-blue',
  45: 'ansi-bg-magenta',
  46: 'ansi-bg-cyan',
  47: 'ansi-bg-white',
  100: 'ansi-bg-bright-black',
  101: 'ansi-bg-bright-red',
  102: 'ansi-bg-bright-green',
  103: 'ansi-bg-bright-yellow',
  104: 'ansi-bg-bright-blue',
  105: 'ansi-bg-bright-magenta',
  106: 'ansi-bg-bright-cyan',
  107: 'ansi-bg-bright-white',
}

interface AnsiStyle {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  underline?: boolean
}

interface AnsiSegment {
  text: string
  style: AnsiStyle
}

// Match ANSI SGR escape sequences: ESC[...m
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[([0-9;]*)m/g

// Match CSI sequences used by terminal UIs for cursor movement, line clearing,
// bracketed paste/synchronized output, etc.
// eslint-disable-next-line no-control-regex
const CSI_REGEX = /\x1b\[([0-?]*)([ -/]*)([@-~])/y

function parseAnsiCodes(codes: string): Partial<AnsiStyle> {
  const result: Partial<AnsiStyle> = {}
  const parts = codes.split(';').filter(Boolean)

  // Handle empty or just "0" - reset
  if (parts.length === 0 || (parts.length === 1 && parts[0] === '0')) {
    return { fg: undefined, bg: undefined, bold: false, dim: false, underline: false }
  }

  for (const part of parts) {
    const code = parseInt(part, 10)
    if (isNaN(code)) continue

    if (code === 0) {
      // Reset all
      result.fg = undefined
      result.bg = undefined
      result.bold = false
      result.dim = false
      result.underline = false
    } else if (code === 1) {
      result.bold = true
    } else if (code === 2) {
      result.dim = true
    } else if (code === 4) {
      result.underline = true
    } else if (code === 22) {
      // Normal intensity (neither bold nor dim)
      result.bold = false
      result.dim = false
    } else if (code === 24) {
      // Underline off
      result.underline = false
    } else if (code === 39) {
      // Default foreground
      result.fg = undefined
    } else if (code === 49) {
      // Default background
      result.bg = undefined
    } else if (FG_COLORS[code]) {
      result.fg = FG_COLORS[code]
    } else if (BG_COLORS[code]) {
      result.bg = BG_COLORS[code]
    }
  }

  return result
}

function hasVisibleText(line: string): boolean {
  return line.replace(ANSI_REGEX, '').length > 0
}

function normalizeTerminalText(text: string): string {
  const lines: string[] = ['']
  let row = 0
  let col = 0
  let i = 0

  const ensureRow = () => {
    while (lines.length <= row) lines.push('')
  }

  while (i < text.length) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      CSI_REGEX.lastIndex = i
      const match = CSI_REGEX.exec(text)
      if (match) {
        const sequence = match[0]
        const params = match[1]
        const final = match[3]

        if (final === 'm') {
          lines[row] += sequence
        } else if (final === 'A') {
          row = Math.max(0, row - (parseInt(params, 10) || 1))
          col = 0
        } else if (final === 'G') {
          col = Math.max(0, (parseInt(params, 10) || 1) - 1)
        } else if (final === 'K') {
          // Most progress renderers use CR/column 0 + clear-line before
          // rewriting a line. Fully slicing ANSI-styled lines by visible
          // columns is overkill here, so handle the common full-line clear
          // precisely and leave partial clears as-is.
          if (col === 0 || params === '2') lines[row] = ''
        }

        i = CSI_REGEX.lastIndex
        continue
      }
    }

    const char = text[i]
    if (char === '\r') {
      col = 0
    } else if (char === '\n') {
      row += 1
      col = 0
      ensureRow()
    } else {
      ensureRow()
      if (col === 0 && hasVisibleText(lines[row])) {
        lines[row] = char
      } else {
        lines[row] += char
      }
      col += 1
    }
    i += 1
  }

  return lines.join('\n')
}

function parseAnsiText(text: string): AnsiSegment[] {
  const normalizedText = normalizeTerminalText(text)
  const segments: AnsiSegment[] = []
  let currentStyle: AnsiStyle = {}
  let lastIndex = 0

  // Reset regex state
  ANSI_REGEX.lastIndex = 0

  let match
  while ((match = ANSI_REGEX.exec(normalizedText)) !== null) {
    // Add text before this escape sequence
    if (match.index > lastIndex) {
      const textBefore = normalizedText.slice(lastIndex, match.index)
      if (textBefore) {
        segments.push({ text: textBefore, style: { ...currentStyle } })
      }
    }

    // Apply the style changes from this escape sequence
    const styleChanges = parseAnsiCodes(match[1])
    currentStyle = { ...currentStyle, ...styleChanges }

    lastIndex = match.index + match[0].length
  }

  // Add remaining text after last escape sequence
  if (lastIndex < normalizedText.length) {
    segments.push({ text: normalizedText.slice(lastIndex), style: { ...currentStyle } })
  }

  return segments
}

function styleToClassName(style: AnsiStyle): string {
  const classes: string[] = []

  if (style.fg) classes.push(style.fg)
  if (style.bg) classes.push(style.bg)
  if (style.bold) classes.push('font-bold')
  if (style.dim) classes.push('opacity-60')
  if (style.underline) classes.push('underline')

  return classes.join(' ')
}

function hasStyle(style: AnsiStyle): boolean {
  return !!(style.fg || style.bg || style.bold || style.dim || style.underline)
}

interface AnsiTextProps {
  children: string
  className?: string
}

export function AnsiText({ children, className }: AnsiTextProps) {
  const segments = useMemo(() => parseAnsiText(children), [children])

  // If no ANSI codes found, return plain text
  if (segments.length === 0) {
    return <>{children}</>
  }

  // If single segment with no styling, return plain text
  if (segments.length === 1 && !hasStyle(segments[0].style)) {
    return <>{segments[0].text}</>
  }

  return (
    <span className={className}>
      {segments.map((segment, i) => {
        const className = styleToClassName(segment.style)
        if (!className) {
          return <span key={i}>{segment.text}</span>
        }
        return (
          <span key={i} className={className}>
            {segment.text}
          </span>
        )
      })}
    </span>
  )
}

// Export for testing
export { parseAnsiText, parseAnsiCodes }
