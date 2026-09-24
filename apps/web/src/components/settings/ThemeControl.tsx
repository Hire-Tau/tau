import { ThemePresetLibrary } from './ThemePresetLibrary'
import type { AppearanceSetting } from '@tau/shared'
import type { useTheme } from '../../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme, THEME_PICKER_ENABLED } from '../../theme/registry'

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

export function ThemeControl({
  value,
  enabled = THEME_PICKER_ENABLED,
}: {
  value: ReturnType<typeof useTheme>
  enabled?: boolean
}) {
  const { themeId, appearance, setThemeId, setAppearance, theme, toggleTheme } = value
  const selected = findWebTheme(themeId)
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
              value={selected.id}
              onChange={(event) => setThemeId(event.target.value)}
            >
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
