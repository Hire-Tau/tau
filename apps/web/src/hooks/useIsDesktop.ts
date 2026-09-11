import { useEffect, useState } from 'react'

const DESKTOP_QUERY = '(min-width: 768px)'

type LegacyMediaQueryList = MediaQueryList & {
  addListener: (listener: (event: MediaQueryListEvent) => void) => void
  removeListener: (listener: (event: MediaQueryListEvent) => void) => void
}

function matchesDesktop(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia(DESKTOP_QUERY).matches
}

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(matchesDesktop)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    const mediaQuery = window.matchMedia(DESKTOP_QUERY)
    const handleChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)

    setIsDesktop(mediaQuery.matches)

    if ('addEventListener' in mediaQuery) {
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }

    const legacyMediaQuery = mediaQuery as LegacyMediaQueryList
    legacyMediaQuery.addListener(handleChange)
    return () => legacyMediaQuery.removeListener(handleChange)
  }, [])

  return isDesktop
}
