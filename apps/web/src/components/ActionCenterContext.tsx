import { createContext, useContext } from 'react'

interface ActionCenterContextValue {
  closeActionCenter: () => void
}

export const ActionCenterContext = createContext<ActionCenterContextValue | null>(null)

export function useActionCenter() {
  const context = useContext(ActionCenterContext)
  if (!context) {
    // Return a no-op if used outside ActionCenter (graceful fallback)
    return { closeActionCenter: () => {} }
  }
  return context
}
