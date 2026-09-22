import { createContext } from 'react'

/** The nearest chat container owns its identity, tabs, and fullscreen layout. */
export const ChatFullscreenContext = createContext<(() => void) | null>(null)
