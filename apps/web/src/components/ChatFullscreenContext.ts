import { createContext } from 'react'

/** The nearest chat container owns expansion; false keeps composers inside an already-sized surface. */
export const ChatFullscreenContext = createContext<(() => void) | false | null>(null)
