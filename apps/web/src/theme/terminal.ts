import type { ITheme } from '@xterm/xterm'

const TERMINAL_TOKENS = {
  background: '--term-bg',
  foreground: '--term-fg',
  cursor: '--term-cursor',
  cursorAccent: '--term-cursor-accent',
  selectionBackground: '--term-selection-background',
  selectionForeground: '--term-selection-foreground',
  black: '--term-black',
  red: '--term-red',
  green: '--term-green',
  yellow: '--term-yellow',
  blue: '--term-blue',
  magenta: '--term-magenta',
  cyan: '--term-cyan',
  white: '--term-white',
  brightBlack: '--term-bright-black',
  brightRed: '--term-bright-red',
  brightGreen: '--term-bright-green',
  brightYellow: '--term-bright-yellow',
  brightBlue: '--term-bright-blue',
  brightMagenta: '--term-bright-magenta',
  brightCyan: '--term-bright-cyan',
  brightWhite: '--term-bright-white',
} as const satisfies Partial<Record<keyof ITheme, string>>

/** xterm 5's fast parser expects comma-form RGB, not CSS variables/channels. */
export function terminalTokenColor(channels: string): string | undefined {
  // `none` preserves each selected cell's ANSI foreground. `auto` leaves native
  // scrollbars alone. Neither is a color to pass into xterm's canvas parser.
  if (!channels || channels === 'none' || channels === 'auto') return undefined
  const [rgb, alpha] = channels.split('/').map((part) => part.trim())
  const parts = rgb!.split(/\s+/)
  if (alpha !== undefined) return `rgba(${parts.join(', ')}, ${alpha})`
  return `rgb(${parts.join(', ')})`
}

export function readTerminalTheme(
  style: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
  palette: 'term' | 'log' = 'term'
): ITheme {
  return Object.fromEntries(
    Object.entries(TERMINAL_TOKENS).map(([key, token]) => [
      key,
      terminalTokenColor(style.getPropertyValue(token.replace('--term-', `--${palette}-`)).trim()),
    ])
  )
}

/**
 * Repaint the existing terminal after CSS scope/override changes; never recreate
 * its session or socket. Observing the applied root (rather than a React theme
 * effect) avoids child/parent effect ordering races and handles custom overrides.
 * The constructor also reads tokens BEFORE open(), so the first canvas is right.
 */
export function observeTerminalTheme(
  terminal: { options: { theme?: ITheme } },
  container: HTMLElement,
  palette: 'term' | 'log' = 'term'
): () => void {
  const root = container.ownerDocument.documentElement
  const view = container.ownerDocument.defaultView!
  const update = () => {
    const style = view.getComputedStyle(root)
    terminal.options.theme = readTerminalTheme(style, palette)
    // xterm 5.5 has no scrollbar entries in ITheme. Its viewport is a native
    // scrollbar; opt into CSS styling only when a theme replaces the auto token.
    container.toggleAttribute(
      'data-terminal-scrollbar',
      !!terminalTokenColor(style.getPropertyValue('--term-scrollbar-thumb').trim())
    )
  }
  const observer = new view.MutationObserver(update)
  observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-appearance'] })
  update()
  return () => observer.disconnect()
}
