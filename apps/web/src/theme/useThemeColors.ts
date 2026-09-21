import { useSyncExternalStore } from 'react'
import { themeTokenReader, type ThemeColors } from './tokenReader'

const empty: ThemeColors = Object.freeze({})
const serverSnapshot = () => empty
const noSubscribe = () => () => {}

/** Consumers repaint existing canvases on applied theme/appearance/override changes. */
export function useThemeColors(): ThemeColors {
  const reader = typeof document === 'undefined' ? undefined : themeTokenReader(document.documentElement)
  return useSyncExternalStore(reader?.subscribe ?? noSubscribe, reader?.getSnapshot ?? serverSnapshot, serverSnapshot)
}
