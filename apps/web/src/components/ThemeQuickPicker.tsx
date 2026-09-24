import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { EffectiveAppearance, ThemePreset } from '@tau/shared'
import type { useTheme } from '../providers/ThemeProvider'
import { useThemeSyncStore } from '../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme, THEME_PICKER_ENABLED, type WebThemeDefinition } from '../theme/registry'
import { applyResolvedTheme } from '../theme/apply'
import { applyCustomTheme, removeCustomProperties } from '../theme/custom'
import { paintRoot } from '../theme/preview'
import { useStableRef } from '../hooks/useStableRef'
import { PaletteIcon, SunIcon, MoonIcon, MonitorIcon } from './icons'
import { THEME_CONSTANT_HINT, ThemeSyncNotice } from './settings/ThemeControl'

/** Sweeping the row must not strobe the whole app; only a settled hover previews. */
const HOVER_PREVIEW_DELAY_MS = 100

type Circle =
  | { kind: 'builtin'; id: string; label: string; theme: WebThemeDefinition }
  | { kind: 'preset'; id: string; label: string; preset: ThemePreset }

const APPEARANCE_OPTIONS = [
  ['light', 'Light', SunIcon],
  ['dark', 'Dark', MoonIcon],
  ['system', 'System', MonitorIcon],
] as const

/** A preset's document always covers both variants; a circle preview/swatch
 * never forces a particular side, it just resolves the app's current one. */
function presetAppearance(preset: ThemePreset, currentAppearance: EffectiveAppearance): EffectiveAppearance {
  return findWebTheme(preset.document.base).kind === 'unified' ? 'constant' : currentAppearance
}

/**
 * Desktop header theme picker: swap the color palette without opening
 * Settings. Circles are every built-in plus the caller's saved theme presets;
 * hovering previews the whole app on intent and always fully restores the
 * stored selection; clicking persists through the existing ThemeProvider
 * paths (setThemeId / applyPreset), so sync and device-override behavior is
 * identical to the Settings ThemeControl.
 */
export function ThemeQuickPicker({
  value,
  presets = [],
  enabled = THEME_PICKER_ENABLED,
}: {
  value: ReturnType<typeof useTheme>
  /** The caller's saved theme presets (fetched via React Query at the call site). */
  presets?: ThemePreset[]
  enabled?: boolean
}) {
  const store = useThemeSyncStore()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const presetSwatchRefs = useRef(new Map<string, HTMLElement>())
  const panelId = useId()
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previewActive = useRef(false)
  const valueRef = useStableRef(value)

  const circles: Circle[] = [
    ...BUILT_IN_THEMES.map((theme) => ({ kind: 'builtin' as const, id: theme.id, label: theme.label, theme })),
    ...presets.map((preset) => ({ kind: 'preset' as const, id: preset.id, label: preset.document.name, preset })),
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
    if (circle.kind === 'preset')
      paintRoot(
        root,
        findWebTheme(circle.preset.document.base),
        presetAppearance(circle.preset, valueRef.current.theme),
        circle.preset.document
      )
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
    if (circle.kind === 'preset') value.applyPreset(circle.preset)
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

  // Paint every preset's own circle from its compiled document (not the hover
  // preview), the same way the editor paints its live preview.
  useLayoutEffect(() => {
    for (const preset of presets) {
      const element = presetSwatchRefs.current.get(preset.id)
      if (!element) continue
      const theme = findWebTheme(preset.document.base)
      const appearance = presetAppearance(preset, value.theme)
      removeCustomProperties(element)
      applyResolvedTheme(element, theme, appearance)
      try {
        applyCustomTheme(element, preset.document, appearance)
      } catch {
        removeCustomProperties(element)
      }
    }
  }, [presets, value.theme, open])

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
                circle.kind === 'preset' ? value.presetId === circle.id : !value.presetId && value.themeId === circle.id
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
                    ref={
                      circle.kind === 'preset'
                        ? (el) => {
                            if (el) presetSwatchRefs.current.set(circle.id, el)
                            else presetSwatchRefs.current.delete(circle.id)
                          }
                        : undefined
                    }
                    data-theme-scope=""
                    data-theme={circle.kind === 'preset' ? undefined : circle.id}
                    data-appearance={
                      circle.kind === 'preset' ? undefined : circle.theme.kind === 'unified' ? undefined : value.theme
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
