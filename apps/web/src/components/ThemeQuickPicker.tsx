import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { CustomThemeDocument, EffectiveAppearance } from '@tau/shared'
import type { useTheme } from '../providers/ThemeProvider'
import { useThemeSyncStore } from '../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme, THEME_PICKER_ENABLED, type WebThemeDefinition } from '../theme/registry'
import { applyResolvedTheme } from '../theme/apply'
import { applyCustomTheme, removeCustomProperties } from '../theme/custom'
import { useStableRef } from '../hooks/useStableRef'
import { PaletteIcon, SunIcon, MoonIcon, MonitorIcon } from './icons'
import { THEME_CONSTANT_HINT, ThemeSyncNotice } from './settings/ThemeControl'

/** Sweeping the row must not strobe the whole app; only a settled hover previews. */
const HOVER_PREVIEW_DELAY_MS = 100

type Circle =
  | { kind: 'builtin'; id: string; label: string; theme: WebThemeDefinition }
  | { kind: 'custom'; id: 'custom'; label: string; document: CustomThemeDocument }

const APPEARANCE_OPTIONS = [
  ['light', 'Light', SunIcon],
  ['dark', 'Dark', MoonIcon],
  ['system', 'System', MonitorIcon],
] as const

/** Full repaint of one root/element: mirrors ThemeProvider's own effect body
 * (minus persistence), so preview/restore and the real applied theme never
 * drift from each other. Pure DOM; never touches storage or the store. */
function paintRoot(
  root: HTMLElement,
  theme: WebThemeDefinition,
  appearance: EffectiveAppearance,
  custom: CustomThemeDocument | null
) {
  removeCustomProperties(root)
  applyResolvedTheme(root, theme, appearance)
  if (!custom) return
  try {
    applyCustomTheme(root, custom)
  } catch {
    // Preview/restore never mutates the store or recovers persisted state
    // (that belongs to ThemeProvider); fall back to the plain builtin paint.
    removeCustomProperties(root)
  }
}

/**
 * Desktop header theme picker: swap the color palette without opening
 * Settings. Circles preview the whole app on hover intent and always fully
 * restore the stored selection; clicking persists through the existing
 * ThemeProvider paths (setThemeId / applyCustom), so sync and device-override
 * behavior is identical to the Settings ThemeControl.
 */
export function ThemeQuickPicker({
  value,
  enabled = THEME_PICKER_ENABLED,
}: {
  value: ReturnType<typeof useTheme>
  enabled?: boolean
}) {
  const store = useThemeSyncStore()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const customSwatchRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previewActive = useRef(false)
  const valueRef = useStableRef(value)

  const circles: Circle[] = [
    ...BUILT_IN_THEMES.map((theme) => ({ kind: 'builtin' as const, id: theme.id, label: theme.label, theme })),
    ...(value.customTheme
      ? [{ kind: 'custom' as const, id: 'custom' as const, label: value.customTheme.name, document: value.customTheme }]
      : []),
  ]

  const restorePreview = () => {
    clearTimeout(previewTimer.current)
    previewTimer.current = undefined
    if (!previewActive.current) return
    previewActive.current = false
    // Re-read the store now, not a value captured when the hover started: the
    // stored selection may have changed (another tab, Settings) mid-preview.
    const snapshot = store.getSnapshot()
    const themeDef = findWebTheme(snapshot.selection.themeId)
    const appearance: EffectiveAppearance = themeDef.kind === 'unified' ? 'constant' : valueRef.current.theme
    paintRoot(document.documentElement, themeDef, appearance, snapshot.custom)
  }

  const applyPreview = (circle: Circle) => {
    previewActive.current = true
    const root = document.documentElement
    if (circle.kind === 'custom')
      paintRoot(root, findWebTheme(circle.document.base), circle.document.appearance, circle.document)
    // Palette-only preview: keep the app's current effective appearance.
    else paintRoot(root, circle.theme, valueRef.current.theme, null)
  }

  const startPreview = (circle: Circle) => {
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => applyPreview(circle), HOVER_PREVIEW_DELAY_MS)
  }

  const close = () => {
    restorePreview()
    setOpen(false)
  }

  const selectCircle = (circle: Circle) => {
    restorePreview()
    if (circle.kind === 'custom') value.applyCustom(circle.document)
    else value.setThemeId(circle.id)
  }

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const selected = panel?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
    ;(selected ?? panel?.querySelector<HTMLElement>('[role="radio"]'))?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Paint the active custom theme's own circle from the real document (not
  // the hover preview), the same way CustomThemeEditor paints its preview.
  useLayoutEffect(() => {
    const element = customSwatchRef.current
    if (!element || !value.customTheme) return
    removeCustomProperties(element)
    applyResolvedTheme(element, findWebTheme(value.customTheme.base), value.customTheme.appearance)
    try {
      applyCustomTheme(element, value.customTheme)
    } catch {
      removeCustomProperties(element)
    }
  }, [value.customTheme, open])

  if (!enabled) return null

  const appearanceDisabled = findWebTheme(value.themeId).kind === 'unified'
  const hintId = `${panelId}-hint`

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title="Theme"
        onClick={() => (open ? close() : setOpen(true))}
        className={clsx(
          'hidden md:flex items-center justify-center p-2 rounded-md',
          open ? 'bg-selection text-accent-light' : 'text-muted hover:text-primary hover:bg-surface-hover'
        )}
      >
        <PaletteIcon className="w-5 h-5" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Theme"
          className="tau-overlay absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-xl border border-th-border bg-surface p-3 shadow-theme-lg"
        >
          <div role="radiogroup" aria-label="Color theme" className="flex flex-wrap gap-2">
            {circles.map((circle) => {
              const selected =
                circle.kind === 'custom' ? !!value.customTheme : !value.customTheme && value.themeId === circle.id
              return (
                <button
                  key={circle.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={circle.label}
                  className={clsx(
                    'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
                    selected && 'ring-2 ring-accent ring-offset-2 ring-offset-surface'
                  )}
                  onMouseEnter={() => startPreview(circle)}
                  onMouseLeave={restorePreview}
                  onClick={() => selectCircle(circle)}
                  onKeyDown={(event) => {
                    // Explicit, rather than relying on native button default
                    // action: preventDefault suppresses that default so a real
                    // browser never double-fires this on the same keypress.
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    selectCircle(circle)
                  }}
                >
                  <span
                    ref={circle.kind === 'custom' ? customSwatchRef : undefined}
                    data-theme-scope=""
                    data-theme={circle.kind === 'custom' ? undefined : circle.id}
                    data-appearance={
                      circle.kind === 'custom' ? undefined : circle.theme.kind === 'unified' ? undefined : value.theme
                    }
                    className="theme-quick-picker-swatch block h-full w-full rounded-full"
                  />
                </button>
              )
            })}
          </div>
          <div
            role="radiogroup"
            aria-label="Appearance"
            className="mt-3 flex gap-1 rounded-lg bg-surface-secondary p-1"
          >
            {APPEARANCE_OPTIONS.map(([setting, label, Icon]) => (
              <button
                key={setting}
                type="button"
                role="radio"
                aria-checked={value.appearance === setting}
                disabled={appearanceDisabled}
                aria-describedby={appearanceDisabled ? hintId : undefined}
                className={clsx(
                  'flex min-h-[36px] flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium',
                  appearanceDisabled
                    ? 'cursor-default text-muted opacity-60'
                    : value.appearance === setting
                      ? 'bg-accent text-on-accent'
                      : 'text-secondary hover:bg-surface-hover'
                )}
                onClick={() => value.setAppearance(setting)}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          {appearanceDisabled && (
            <p id={hintId} className="mt-2 text-xs text-muted">
              {THEME_CONSTANT_HINT}
            </p>
          )}
          <ThemeSyncNotice value={value} />
        </div>
      )}
    </div>
  )
}
