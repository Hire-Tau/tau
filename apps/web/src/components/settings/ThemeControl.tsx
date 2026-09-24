import { useQuery } from '@tanstack/react-query'
import { ThemePresetLibrary } from './ThemePresetLibrary'
import type { AppearanceSetting, ThemePreset } from '@tau/shared'
import type { useTheme } from '../../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme, THEME_PICKER_ENABLED } from '../../theme/registry'
import { selfServiceQueryEnabled, useOptionalAuth } from '../../providers/AuthProvider'
import { queries } from '../../queryOptions'

/** Shared with ThemeQuickPicker so both entry points explain a unified theme identically. */
export const THEME_CONSTANT_HINT =
  'High contrast has one appearance. Your appearance preference is kept for other themes.'

/** Shared account-sync/device-override notice, identical on both the Settings picker and the header quick picker. */
export function ThemeSyncNotice({
  value,
}: {
  value: Pick<ReturnType<typeof useTheme>, 'syncAvailable' | 'localOverride' | 'adoptSynced'>
}) {
  if (!value.syncAvailable) return null
  return (
    <div className="mt-3 text-sm text-muted">
      <p>
        {value.localOverride
          ? 'This device overrides your synced theme. Changes here also update your account theme.'
          : 'Following your account theme.'}
      </p>
      {value.localOverride && (
        <button className="tau-button tau-button-secondary min-h-[44px] px-3 py-2 mt-2" onClick={value.adoptSynced}>
          Use synced theme
        </button>
      )}
    </div>
  )
}

/** Sentinel option value for the Color theme select while a custom theme
 * (own preset, someone else's shared preset, or a detached one-off) is
 * active. Picking a real built-in id from the list below it deactivates the
 * preset exactly like the quick picker's circles do — see `setThemeId` —
 * without touching the library. Never collides with a real theme id. */
const CUSTOM_THEME_OPTION_VALUE = '__custom-theme__'

// Hoisted so a caller whose "mine" list hasn't resolved yet doesn't create a
// new empty array every render (mirrors ThemeQuickPicker's EMPTY).
const EMPTY_PRESETS: ThemePreset[] = []

export function ThemeControl({
  value,
  enabled = THEME_PICKER_ENABLED,
}: {
  value: ReturnType<typeof useTheme>
  enabled?: boolean
}) {
  const { themeId, appearance, setThemeId, setAppearance, theme, toggleTheme, customTheme, presetId } = value
  const selected = findWebTheme(themeId)
  const auth = useOptionalAuth()
  const { data: minePresets = EMPTY_PRESETS, isSuccess: mineLoaded } = useQuery({
    ...queries.themePresets.list('mine'),
    enabled: selfServiceQueryEnabled(auth),
  })
  const customActive = !!customTheme
  // A preset id present but absent from the caller's own library is someone
  // else's shared preset (see ThemeProvider's presetOwnerId doc comment) —
  // the same "not in my list" test ThemeQuickPicker's activeForeignPreset uses.
  // Until the library has loaded, don't guess: an own preset would flash "(shared)".
  const foreignPreset = !!presetId && mineLoaded && !minePresets.some((preset) => preset.id === presetId)
  const customOptionLabel = customTheme
    ? foreignPreset
      ? `${customTheme.name} (shared)`
      : `Custom: ${customTheme.name}`
    : ''
  return (
    <section data-setting-target="appearance" aria-label="Theme" className="tau-section py-5">
      <h3 data-setting-target="dark-mode" className="font-medium text-primary">
        Theme
      </h3>
      {enabled ? (
        <div className="mt-3 flex flex-col sm:flex-row gap-4">
          <label className="flex flex-col gap-1 text-sm text-secondary">
            Color theme
            <select
              className="tau-field px-3 py-2 min-h-[44px]"
              value={customActive ? CUSTOM_THEME_OPTION_VALUE : selected.id}
              onChange={(event) => {
                // The custom entry is never itself a choosable target (it's
                // already selected) — a real change always picks a built-in,
                // which deactivates the preset (kept in the library) exactly
                // like the quick picker's circles do.
                if (event.target.value === CUSTOM_THEME_OPTION_VALUE) return
                setThemeId(event.target.value)
              }}
            >
              {customActive && <option value={CUSTOM_THEME_OPTION_VALUE}>{customOptionLabel}</option>}
              {BUILT_IN_THEMES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-secondary">
            Appearance
            <select
              className="tau-field px-3 py-2 min-h-[44px]"
              value={appearance}
              disabled={selected.kind === 'unified'}
              aria-describedby={selected.kind === 'unified' ? 'theme-constant-hint' : undefined}
              onChange={(event) => setAppearance(event.target.value as AppearanceSetting)}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </label>
          {selected.kind === 'unified' && (
            <p id="theme-constant-hint" className="text-sm text-muted self-end">
              {THEME_CONSTANT_HINT}
            </p>
          )}
        </div>
      ) : (
        <button className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary mt-3" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        </button>
      )}
      <ThemeSyncNotice value={value} />
      {value.customThemeError && <p role="alert">{value.customThemeError}</p>}
      {enabled && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary" onClick={value.resetTheme}>
              Reset to default
            </button>
          </div>
          <p className="mt-1 text-xs text-muted">
            Switches back to Tau (light). Your saved theme presets aren't touched.
          </p>
          <ThemePresetLibrary value={value} />
        </>
      )}
    </section>
  )
}
