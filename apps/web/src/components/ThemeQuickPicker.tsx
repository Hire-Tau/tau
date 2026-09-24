import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ThemePreset } from '@tau/shared'
import type { useTheme } from '../providers/ThemeProvider'
import { useThemePreview } from '../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme, THEME_PICKER_ENABLED, type WebThemeDefinition } from '../theme/registry'
import { presetAppearance } from '../theme/custom'
import { paintRoot } from '../theme/preview'
import { useStableRef } from '../hooks/useStableRef'
import { PaletteIcon } from './icons'
import { THEME_CONSTANT_HINT, ThemeSyncNotice } from './settings/ThemeControl'
import { ThemeSwatch } from './ThemeSwatch'
import { SegmentedAppearanceControl } from './SegmentedAppearanceControl'

/** Sweeping the row must not strobe the whole app; only a settled hover previews. */
const HOVER_PREVIEW_DELAY_MS = 100

type Circle =
  | { kind: 'builtin'; id: string; label: string; theme: WebThemeDefinition }
  // Phase 2: a circle for a foreign/shared preset only needs enough of
  // ThemePreset to paint its swatch and re-apply it (id, document, owner) —
  // never the full server DTO, since the quick picker synthesizes one for
  // the currently-active shared preset without an extra fetch (see below).
  | { kind: 'preset'; id: string; label: string; preset: Pick<ThemePreset, 'id' | 'document' | 'owner'> }

// Hoisted so a caller that never passes `presets` (auth-disabled instances,
// or before the query resolves) doesn't create a new empty array every
// render, which would otherwise cost an extra effect run below on each of
// this component's re-renders for no reason.
const EMPTY: ThemePreset[] = []

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
  presets = EMPTY,
  enabled = THEME_PICKER_ENABLED,
}: {
  value: ReturnType<typeof useTheme>
  /** The caller's saved theme presets (fetched via React Query at the call site). */
  presets?: ThemePreset[]
  enabled?: boolean
}) {
  const { setPreview } = useThemePreview()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The unregister function returned by the preview slot's setPreview, or
  // null when no hover preview is currently registered by this component.
  const previewClearRef = useRef<(() => void) | null>(null)
  const valueRef = useStableRef(value)

  // Phase 2: the currently-active preset (own or a foreign shared one) always
  // gets a circle, even when it isn't in `presets` (the caller's own
  // library) — the quick picker stays compact by only ever adding this ONE
  // extra circle, not a whole "Shared" gallery. Synthesized directly from
  // ThemeProvider state (no extra fetch): `presetOwnerId` is populated
  // whenever ANY preset is applied (see ThemeProvider's doc comment), so
  // this also covers the caller's own preset if it somehow isn't in
  // `presets` yet (e.g. the list query hasn't resolved).
  const activeForeignPreset =
    value.presetId &&
    value.presetOwnerId &&
    value.customTheme &&
    !presets.some((preset) => preset.id === value.presetId)
      ? { id: value.presetId, document: value.customTheme, owner: { id: value.presetOwnerId, displayName: '' } }
      : null
  const circles: Circle[] = [
    ...BUILT_IN_THEMES.map((theme) => ({ kind: 'builtin' as const, id: theme.id, label: theme.label, theme })),
    ...presets.map((preset) => ({ kind: 'preset' as const, id: preset.id, label: preset.document.name, preset })),
    ...(activeForeignPreset
      ? [
          {
            kind: 'preset' as const,
            id: activeForeignPreset.id,
            label: activeForeignPreset.document.name,
            preset: activeForeignPreset,
          },
        ]
      : []),
  ]

  const restorePreview = () => {
    clearTimeout(previewTimer.current)
    previewTimer.current = undefined
    // A no-op if a later registrant (e.g. the editor opening mid-hover) has
    // since taken over the slot — see useThemePreview's doc comment.
    previewClearRef.current?.()
    previewClearRef.current = null
  }

  const applyPreview = (circle: Circle) => {
    previewClearRef.current = setPreview(() => {
      const root = document.documentElement
      if (circle.kind === 'preset')
        paintRoot(
          root,
          findWebTheme(circle.preset.document.base),
          presetAppearance(circle.preset.document, valueRef.current.theme),
          circle.preset.document
        )
      // Palette-only preview: keep the app's current effective appearance.
      else paintRoot(root, circle.theme, valueRef.current.theme, null)
    })
  }

  const startPreview = (circle: Circle) => {
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => applyPreview(circle), HOVER_PREVIEW_DELAY_MS)
  }

  // Belt-and-suspenders: if this component unmounts while a hover preview is
  // active (e.g. navigating away mid-hover), restore rather than leaving a
  // stale preview painted. close()/selectCircle() already call
  // restorePreview() on every ordinary path.
  useEffect(() => restorePreview, [])

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
                  <ThemeSwatch
                    spec={
                      circle.kind === 'builtin'
                        ? { kind: 'builtin', theme: circle.theme, appearance: value.theme }
                        : {
                            kind: 'preset',
                            document: circle.preset.document,
                            appearance: presetAppearance(circle.preset.document, value.theme),
                          }
                    }
                    className="h-full w-full"
                  />
                </button>
              )
            })}
          </div>
          <SegmentedAppearanceControl
            value={value.appearance}
            onChange={value.setAppearance}
            disabled={appearanceDisabled}
            hintId={hintId}
            className="mt-3"
          />
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
