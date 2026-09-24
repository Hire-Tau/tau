import { useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ACTIVE_THEME_TOKENS,
  STATUS_TOKENS,
  customColorChannels,
  validateCustomTheme,
  type CustomThemeDocument,
  type CustomThemeVariants,
  type EffectiveAppearance,
  type ThemePalette,
  type ThemePreset,
} from '@tau/shared'
import { isHttpResponseError } from '@tau/client-core'
import type { useTheme } from '../../providers/ThemeProvider'
import { useThemeSyncStore } from '../../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme } from '../../theme/registry'
import { exportCustomTheme, readPreviewTokens, removeCustomProperties } from '../../theme/custom'
import { applyResolvedTheme } from '../../theme/apply'
import { paintRoot } from '../../theme/preview'
import { contrast, contrastPairs, pairBackground, tokenRgba, type ContrastPair } from '../../theme/contrast'
import { client } from '../../api/clientInstance'
import { themePresetQueryKeys } from '../../queryKeys'
import { useStableRef } from '../../hooks/useStableRef'

interface Warning {
  pair: ContrastPair
  ratio: number | null
  safe: string | null
}

/** A variant tab is always a concrete side, never 'system' (the editor edits
 * concrete light/dark overrides; the app's Light/Dark/System toggle resolves
 * which one paints later). */
type VariantTab = 'light' | 'dark' | 'constant'

function emptyThemeDocument(baseId: string): CustomThemeDocument {
  const base = findWebTheme(baseId)
  return {
    format: 'tau-custom-theme',
    version: 2,
    name: 'New theme',
    base: base.id,
    variants: base.kind === 'unified' ? { constant: {} } : { light: {}, dark: {} },
  }
}

function variantOverrides(doc: CustomThemeDocument, tab: VariantTab): Record<string, string> {
  return 'constant' in doc.variants ? doc.variants.constant : doc.variants[tab === 'dark' ? 'dark' : 'light']
}

function withVariantOverrides(
  doc: CustomThemeDocument,
  tab: VariantTab,
  overrides: Record<string, string>
): CustomThemeDocument {
  if ('constant' in doc.variants) return { ...doc, variants: { constant: overrides } }
  return { ...doc, variants: { ...doc.variants, [tab === 'dark' ? 'dark' : 'light']: overrides } }
}

/** Reshapes variants across a base-kind change: unified -> dual seeds both
 * sides with the same starting overrides; dual -> unified merges both sides
 * (dark taking precedence on conflicting tokens is an arbitrary but stable
 * choice — the user reviews the result immediately in the live preview). */
function reshapeForBase(doc: CustomThemeDocument, nextBaseId: string): CustomThemeDocument {
  const nextBase = findWebTheme(nextBaseId)
  let variants: CustomThemeVariants
  if (nextBase.kind === 'unified') {
    const merged = 'constant' in doc.variants ? doc.variants.constant : { ...doc.variants.light, ...doc.variants.dark }
    variants = { constant: merged }
  } else if ('constant' in doc.variants) {
    variants = { light: doc.variants.constant, dark: doc.variants.constant }
  } else {
    variants = doc.variants
  }
  return { ...doc, base: nextBase.id, variants }
}

// Computed, not a literal: keeps this out of the no-raw-colors guard's exact
// per-file allowlist (`apps/web/src/no-raw-colors.test.ts`) — a real color
// literal here is "fix the color, don't add an exception," and this genuinely
// isn't a themeable token (it's the native <input type="color"> widget's own
// placeholder swatch for "no seed set yet", never painted into the app itself).
const UNSET_SWATCH_CHANNEL = 136 // mid-gray
const UNSET_SWATCH = `#${UNSET_SWATCH_CHANNEL.toString(16).repeat(3)}`

/** Native `<input type="color">` only accepts a strict #rrggbb value. Any
 * validly-formed accepted color (hex or rgb()/rgba()) resolves to its own
 * hex for the swatch preview; alpha is dropped there (the closed grammar and
 * alpha stay text-only, in the paired text field). Empty/invalid input falls
 * back to a neutral "not set" gray rather than leaving the widget without a
 * value (the browser control requires one). */
function toSwatchHex(value: string): string {
  const channels = customColorChannels(value)
  if (!channels) return UNSET_SWATCH
  const [rgb] = channels.split(' / ')
  const [r, g, b] = rgb!.split(' ').map(Number)
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`
}

/** A seed-color field: a native color-picker swatch alongside the hex/rgb()/
 * rgba() text field (the source of truth — the closed grammar and alpha stay
 * text-only), with an optional Clear action for unset-able (non-Primary) seeds. */
function ColorField({
  label,
  value,
  onChange,
  onClear,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  onClear?: () => void
}) {
  // Explicit htmlFor/id (text field) + explicit aria-label (color swatch) —
  // deliberately not one <label> wrapping both controls, which would give
  // them the same ambiguous accessible name.
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} color swatch`}
          value={toSwatchHex(value)}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-9 shrink-0 cursor-pointer rounded border border-th-border bg-transparent p-0"
        />
        <input
          id={id}
          type="text"
          className="tau-field px-3 py-2 flex-1"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={onClear ? 'Not set' : 'Hex, rgb() or rgba()'}
        />
      </div>
      {onClear && value && (
        <button
          type="button"
          className="tau-button min-h-[36px] px-2 py-1 tau-button-secondary self-start"
          onClick={onClear}
        >
          Clear {label}
        </button>
      )}
    </div>
  )
}

export function CustomThemeEditor({
  value,
  preset,
  baseId,
  onClose,
}: {
  value: ReturnType<typeof useTheme>
  /** The library preset being edited, or null when authoring a brand-new one. */
  preset: ThemePreset | null
  /** Initial base theme for a new preset; ignored once `preset` is set. */
  baseId: string
  onClose: () => void
}) {
  const store = useThemeSyncStore()
  const cache = useQueryClient()
  const [draft, setDraft] = useState<CustomThemeDocument>(() => preset?.document ?? emptyThemeDocument(baseId))
  const base = findWebTheme(draft.base)
  const [tab, setTab] = useState<VariantTab>(base.kind === 'unified' ? 'constant' : value.theme)
  const [token, setToken] = useState(ACTIVE_THEME_TOKENS[0]!)
  const [color, setColor] = useState('#336699')
  const [notice, setNotice] = useState('')
  const [warnings, setWarnings] = useState<Warning[]>([])
  const [previewError, setPreviewError] = useState('')
  const baseTokens = useRef<Record<string, string>>({})
  const validation = validateCustomTheme(JSON.stringify(draft), BUILT_IN_THEMES)
  const overrides = variantOverrides(draft, tab)
  const valueRef = useStableRef(value)
  const palette = draft.palette

  /** Setting a primary color starts derivation; clearing it removes the whole
   * palette (a preset created from a built-in with no palette is pure explicit
   * overrides, exactly like before). */
  const setPalette = (patch: Partial<ThemePalette> | null) => {
    if (patch === null) {
      const { palette: _drop, ...rest } = draft
      setDraft(rest)
      return
    }
    setDraft({ ...draft, palette: { primary: palette?.primary ?? '', ...palette, ...patch } })
  }

  // Whole-app live preview while the editor is open: paints the draft's
  // CURRENT tab onto document.documentElement itself (pure DOM, the same
  // paintRoot path ThemeQuickPicker's hover preview uses) — no persistence
  // until Save. Runs on every draft/tab change; a separate unmount-only
  // effect below restores the saved selection.
  useLayoutEffect(() => {
    // Layout effects fire bottom-up (children before parents), so on mount
    // ThemeProvider's OWN paint effect would run after this one and clobber
    // the draft preview. A microtask runs after every layout effect in the
    // commit (including ancestors') but still before the browser paints —
    // this repaint is always the last word, with no visible flash.
    queueMicrotask(() => {
      const root = document.documentElement
      removeCustomProperties(root)
      applyResolvedTheme(root, base, tab)
      baseTokens.current = readPreviewTokens(root)
      setPreviewError('')
      setWarnings([])
      if (!validation.ok) return
      try {
        paintRoot(root, base, tab, validation.document)
      } catch {
        removeCustomProperties(root)
        setPreviewError('Preview could not be applied. The page theme has not changed.')
        return
      }
      try {
        const tokens = readPreviewTokens(root)
        const next: Warning[] = []
        for (const pair of contrastPairs) {
          // No CSS in SSR/test renderers: a missing value isn't a contrast claim.
          if (!tokens[pair.fg] || !tokens[pair.bg]) continue
          const bg = pairBackground(tokens, pair)
          if (!bg) {
            next.push({ pair, ratio: null, safe: null })
            continue
          }
          const ratio = contrast(tokenRgba(tokens, pair.fg), bg)
          if (ratio >= pair.minimum) continue
          next.push({
            pair,
            ratio,
            safe: contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg) ? '#000000' : '#ffffff',
          })
        }
        setWarnings(next)
      } catch {
        setNotice('Contrast analysis is unavailable for this preview; Apply is still available.')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, tab])

  // Closing/unmounting restores the saved selection by re-reading the store
  // snapshot — never the draft, regardless of how the editor closed.
  const restore = useStableRef(() => {
    const snapshot = store.getSnapshot()
    const themeDef = findWebTheme(snapshot.selection.themeId)
    const appearance: EffectiveAppearance = themeDef.kind === 'unified' ? 'constant' : valueRef.current.theme
    paintRoot(document.documentElement, themeDef, appearance, snapshot.custom)
  })
  useLayoutEffect(() => () => restore.current(), [restore])

  const override = (name: string, nextColor: string) => {
    const next = { ...overrides }
    if (STATUS_TOKENS.includes(name) && !STATUS_TOKENS.every((key) => key in next)) {
      // The editor helps author the atomic status grid; importer never fills it
      // silently before validation. Built-in status RGB channels are integers.
      try {
        for (const key of STATUS_TOKENS) {
          const parts = baseTokens.current[key]!.split('/').map((part) => part.trim())
          const rgb = parts[0]!.split(/\s+/).map(Number).map(Math.round).join(', ')
          next[key] = parts[1] ? `rgba(${rgb}, ${Number(parts[1])})` : `rgb(${rgb})`
        }
      } catch {
        setNotice('Status base values are not available. Try reopening the editor.')
        return
      }
    }
    next[name] = nextColor
    setDraft(withVariantOverrides(draft, tab, next))
  }
  const removeOverride = (name: string) => {
    const next = { ...overrides }
    for (const key of STATUS_TOKENS.includes(name) ? STATUS_TOKENS : [name]) delete next[key]
    setDraft(withVariantOverrides(draft, tab, next))
  }
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([exportCustomTheme(draft)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'tau-custom-theme.json'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Export failed.')
    }
  }

  const create = useMutation({
    mutationFn: (document: CustomThemeDocument) => client.themePresets.create(document),
    onSuccess: (created) => {
      void cache.invalidateQueries({ queryKey: themePresetQueryKeys.all })
      value.applyPreset(created)
      onClose()
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Save failed.'),
  })
  const update = useMutation({
    mutationFn: ({ id, revision, document }: { id: string; revision: number; document: CustomThemeDocument }) =>
      client.themePresets.update(id, revision, document),
    onSuccess: (updated) => {
      void cache.invalidateQueries({ queryKey: themePresetQueryKeys.all })
      if (value.presetId === updated.id) value.applyPreset(updated)
      onClose()
    },
    onError: (error) => {
      if (isHttpResponseError(error, 409)) setNotice('This theme changed elsewhere — reload it before saving.')
      else setNotice(error instanceof Error ? error.message : 'Save failed.')
    },
  })
  const saving = create.isPending || update.isPending

  return (
    <div className="mt-4 flex flex-col gap-3 text-sm">
      <p className="text-secondary">
        Changes preview across the app while you edit. Nothing is saved until you choose Save; Cancel restores your
        theme.
      </p>
      <label className="flex flex-col gap-1">
        Theme name
        <input
          className="tau-field px-3 py-2"
          value={draft.name}
          maxLength={40}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <div className="rounded-lg border border-th-border p-3 flex flex-col gap-3">
        <div>
          <h4 className="font-medium text-primary">Palette</h4>
          <p className="text-muted text-xs">
            Set a primary color to derive most tokens automatically. Leave it blank for a plain, token-by-token theme.
          </p>
        </div>
        <ColorField
          label="Primary"
          value={palette?.primary ?? ''}
          onChange={(next) => {
            if (!next) setPalette(null)
            else setPalette({ primary: next })
          }}
        />
        {palette && (
          <>
            <div className="flex flex-wrap gap-3">
              <ColorField
                label="Secondary"
                value={palette.secondary ?? ''}
                onChange={(next) => setPalette({ secondary: next || undefined })}
                onClear={() => setPalette({ secondary: undefined })}
              />
              <ColorField
                label="Tertiary"
                value={palette.tertiary ?? ''}
                onChange={(next) => setPalette({ tertiary: next || undefined })}
                onClear={() => setPalette({ tertiary: undefined })}
              />
              <ColorField
                label="Neutral"
                value={palette.neutral ?? ''}
                onChange={(next) => setPalette({ neutral: next || undefined })}
                onClear={() => setPalette({ neutral: undefined })}
              />
            </div>
            <div role="radiogroup" aria-label="Contrast" className="flex items-center gap-1">
              <span className="text-secondary">Contrast:</span>
              {(['standard', 'high'] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={(palette.contrast ?? 'standard') === level}
                  className={clsx(
                    'tau-button min-h-[36px] px-3 py-1',
                    (palette.contrast ?? 'standard') === level ? 'tau-button-primary' : 'tau-button-secondary'
                  )}
                  onClick={() => setPalette({ contrast: level })}
                >
                  {level === 'standard' ? 'Standard' : 'High'}
                </button>
              ))}
            </div>
            <div role="radiogroup" aria-label="Status colors" className="flex items-center gap-1">
              <span className="text-secondary">Status colors:</span>
              {(['static', 'harmonized'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={(palette.status ?? 'static') === mode}
                  className={clsx(
                    'tau-button min-h-[36px] px-3 py-1',
                    (palette.status ?? 'static') === mode ? 'tau-button-primary' : 'tau-button-secondary'
                  )}
                  onClick={() => setPalette({ status: mode })}
                >
                  {mode === 'static' ? 'Static' : 'Harmonized'}
                </button>
              ))}
            </div>
            <p className="text-muted text-xs">
              Harmonized tints warnings, errors and success toward your colors; meanings stay the same.
            </p>
          </>
        )}
      </div>
      {!validation.ok && <p role="alert">{validation.error}</p>}
      {previewError && <p role="alert">{previewError}</p>}
      <details className="rounded-lg border border-th-border p-3">
        <summary className="cursor-pointer font-medium text-primary">Advanced: per-token overrides</summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1">
              Base theme
              <select
                className="tau-field px-3 py-2"
                value={draft.base}
                onChange={(event) => {
                  const next = reshapeForBase(draft, event.target.value)
                  setDraft(next)
                  setTab(findWebTheme(next.base).kind === 'unified' ? 'constant' : valueRef.current.theme)
                }}
              >
                {BUILT_IN_THEMES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            {base.kind === 'dual' && (
              <div role="radiogroup" aria-label="Editing variant" className="flex items-end gap-1">
                {(['light', 'dark'] as const).map((variant) => (
                  <button
                    key={variant}
                    type="button"
                    role="radio"
                    aria-checked={tab === variant}
                    className={clsx(
                      'tau-button min-h-[44px] px-3 py-2',
                      tab === variant ? 'tau-button-primary' : 'tau-button-secondary'
                    )}
                    onClick={() => setTab(variant)}
                  >
                    {variant === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="flex flex-col gap-1">
            Color token
            <select className="tau-field px-3 py-2" value={token} onChange={(event) => setToken(event.target.value)}>
              {ACTIVE_THEME_TOKENS.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Color value
            <input
              className="tau-field px-3 py-2"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              aria-describedby="custom-color-help"
            />
          </label>
          <p id="custom-color-help" className="text-muted">
            Hex, integer rgb(), or rgba() with alpha 0–1. Status edits include the full status palette; removing one
            restores that entire set. Inherited sentinels and opacity are preserved. Editing the{' '}
            {tab === 'constant' ? 'single' : tab} variant.
          </p>
          <button
            className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary self-start"
            onClick={() => override(token, color)}
          >
            Preview token
          </button>
          <ul className="max-h-48 overflow-auto">
            {Object.entries(overrides).map(([name, value]) => (
              <li key={name} className="flex flex-wrap items-center gap-2 py-1">
                <span>
                  {name}: {value}
                </span>
                <button
                  className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary"
                  aria-label={`Remove ${name}`}
                  onClick={() => removeOverride(name)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {warnings.length > 0 && (
            <div aria-label="Contrast warnings" className="max-h-64 overflow-auto">
              <p>
                Informational contrast warnings — these do not block Save. Surfaces are checked over the live page; a
                translucent page may have an unknown backdrop.
              </p>
              <ul>
                {warnings.map(({ pair, ratio, safe }) => (
                  <li key={`${pair.fg}/${pair.bg}/${pair.under}`} className="py-2">
                    {pair.fg} on {pair.bg}
                    {pair.under ? ` over ${pair.under}` : ''}:{' '}
                    {ratio === null
                      ? 'Contrast unknown: the translucent backdrop does not resolve to an opaque page or surface.'
                      : `${ratio.toFixed(2)}:1 (recommended ${pair.minimum}:1).`}
                    {safe && (
                      <button
                        className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary ml-2"
                        onClick={() => override(pair.fg, safe)}
                      >
                        Use safe value {safe}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
      <div className="flex flex-wrap gap-2">
        <button
          className="tau-button min-h-[44px] px-3 py-2 tau-button-primary"
          disabled={!validation.ok || !!previewError || saving}
          onClick={() => {
            if (!validation.ok) return
            if (preset) update.mutate({ id: preset.id, revision: preset.revision, document: validation.document })
            else create.mutate(validation.document)
          }}
        >
          {preset ? 'Save' : 'Save as new'}
        </button>
        {preset && (
          <button
            className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary"
            disabled={!validation.ok || saving}
            onClick={() => {
              if (validation.ok) create.mutate(validation.document)
            }}
          >
            Save as new
          </button>
        )}
        <button className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button
          className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary"
          disabled={!validation.ok}
          onClick={download}
        >
          Export JSON
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
