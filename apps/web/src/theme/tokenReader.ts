import { ACTIVE_THEME_TOKENS } from '@tau/shared/theme-schema'

export type ThemeColors = Readonly<Record<string, string | undefined>>

/** Concrete comma-form colors work in Canvas2D, Three/tinycolor, xterm and Vega.
 * Alpha in channel values and separate intrinsic-opacity metadata MULTIPLY;
 * sentinels deliberately remain absent rather than becoming invalid colors.
 */
export function tokenColor(channels: string, intrinsicOpacity = '1'): string | undefined {
  if (!channels || channels === 'none' || channels === 'auto') return undefined
  const [rgb, alpha = '1'] = channels.split('/').map((part) => part.trim())
  const parts = rgb!.split(/\s+/)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(Number(part)))) return undefined
  const opacity = (alpha.endsWith('%') ? Number.parseFloat(alpha) / 100 : Number(alpha)) * Number(intrinsicOpacity)
  return opacity === 1 ? `rgb(${parts.join(', ')})` : `rgba(${parts.join(', ')}, ${opacity})`
}

export function readTokenColor(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>, token: string) {
  const metadata = `--opacity-${token.replace(/^--(?:color-)?/, '')}`
  return tokenColor(style.getPropertyValue(token).trim(), style.getPropertyValue(metadata).trim() || '1')
}

/** One computed-style read per applied scope/override revision, shared by JS
 * consumers. The root attributes are the phase-0 applyResolvedTheme surface.
 * Observing them also catches inline custom overrides, without a React provider
 * ordering race. Signatures make imperative reads synchronous even before the
 * observer fires. No observer survives the last subscriber.
 */
export function createTokenReader(root: Element) {
  const view = root.ownerDocument.defaultView!
  const attributes = ['class', 'style', 'data-theme', 'data-appearance']
  let signature: string | undefined
  let snapshot: ThemeColors
  let observer: MutationObserver | undefined
  const listeners = new Set<() => void>()
  const getSnapshot = (): ThemeColors => {
    const next = JSON.stringify(attributes.map((attribute) => root.getAttribute(attribute)))
    if (!snapshot || next !== signature) {
      signature = next
      const style = view.getComputedStyle(root)
      snapshot = Object.freeze(
        Object.fromEntries(ACTIVE_THEME_TOKENS.map((token) => [token, readTokenColor(style, token)]))
      )
    }
    return snapshot
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    if (!observer) {
      observer = new view.MutationObserver(() => {
        getSnapshot()
        listeners.forEach((notify) => notify())
      })
      observer.observe(root, { attributes: true, attributeFilter: attributes })
    }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        observer?.disconnect()
        observer = undefined
      }
    }
  }
  return { getSnapshot, subscribe }
}

const readers = new WeakMap<Element, ReturnType<typeof createTokenReader>>()
export function themeTokenReader(root: Element) {
  let reader = readers.get(root)
  if (!reader) {
    reader = createTokenReader(root)
    readers.set(root, reader)
  }
  return reader
}
