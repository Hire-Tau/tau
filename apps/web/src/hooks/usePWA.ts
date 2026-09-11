import { useState, useEffect, useCallback } from 'react'
import {
  registerServiceWorker,
  onUpdateAvailable,
  applyUpdate,
  canInstall,
  promptInstall,
  isStandalone,
  getPlatform,
  getPWASupport,
  clearCache,
} from '../lib/serviceWorker'

export interface PWAState {
  isSupported: boolean
  isInstalled: boolean
  isStandalone: boolean
  isOnline: boolean
  canInstall: boolean
  updateAvailable: boolean
  platform: 'ios' | 'android' | 'desktop' | 'unknown'
}

export interface UsePWAReturn extends PWAState {
  promptInstall: () => Promise<boolean>
  applyUpdate: () => Promise<void>
  clearCache: () => Promise<boolean>
}

export function usePWA(): UsePWAReturn {
  const [state, setState] = useState<PWAState>(() => ({
    isSupported: getPWASupport().serviceWorker,
    isInstalled: false,
    isStandalone: isStandalone(),
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    canInstall: canInstall(),
    updateAvailable: false,
    platform: getPlatform(),
  }))

  // Register service worker on mount
  useEffect(() => {
    registerServiceWorker().then((registration) => {
      if (registration) {
        setState((prev) => ({
          ...prev,
          isInstalled: true,
        }))
      }
    })
  }, [])

  // Listen for update availability
  useEffect(() => {
    return onUpdateAvailable((available) => {
      setState((prev) => ({ ...prev, updateAvailable: available }))
    })
  }, [])

  // Listen for online/offline changes
  useEffect(() => {
    const handleOnline = () => setState((prev) => ({ ...prev, isOnline: true }))
    const handleOffline = () => setState((prev) => ({ ...prev, isOnline: false }))

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // Listen for install prompt availability
  useEffect(() => {
    const handleBeforeInstallPrompt = () => {
      setState((prev) => ({ ...prev, canInstall: true }))
    }

    const handleAppInstalled = () => {
      setState((prev) => ({ ...prev, canInstall: false, isStandalone: true }))
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  const handlePromptInstall = useCallback(async () => {
    const result = await promptInstall()
    if (result) {
      setState((prev) => ({ ...prev, canInstall: false }))
    }
    return result
  }, [])

  const handleApplyUpdate = useCallback(async () => {
    await applyUpdate()
  }, [])

  const handleClearCache = useCallback(async () => {
    return clearCache()
  }, [])

  return {
    ...state,
    promptInstall: handlePromptInstall,
    applyUpdate: handleApplyUpdate,
    clearCache: handleClearCache,
  }
}
