import { useState } from 'react'
import { CustomThemeEditor } from './CustomThemeEditor'
import type { AppearanceSetting } from '@tau/shared'
import type { useTheme } from '../../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme, THEME_PICKER_ENABLED } from '../../theme/registry'

export function ThemeControl({
  value,
  enabled = THEME_PICKER_ENABLED,
}: {
  value: ReturnType<typeof useTheme>
  enabled?: boolean
}) {
  const { themeId, appearance, setThemeId, setAppearance, theme, toggleTheme } = value
  const [editing, setEditing] = useState(false)
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
              High contrast has one appearance. Your appearance preference is kept for other themes.
            </p>
          )}
        </div>
      ) : (
        <button className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary mt-3" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        </button>
      )}
      {value.syncAvailable && (
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
      )}
      {value.customTheme && (
        <p className="mt-3 text-sm text-secondary">
          Custom theme: {value.customTheme.name} ({value.customTheme.appearance})
        </p>
      )}
      {value.customThemeError && <p role="alert">{value.customThemeError}</p>}
      {enabled && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary"
              aria-expanded={editing}
              onClick={() => setEditing(!editing)}
            >
              {editing ? 'Close editor' : 'Edit custom theme'}
            </button>
            <button
              className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary"
              onClick={() => {
                value.resetTheme()
                setEditing(false)
              }}
            >
              Reset to default
            </button>
          </div>
          {editing && <CustomThemeEditor value={value} />}
        </>
      )}
    </section>
  )
}
