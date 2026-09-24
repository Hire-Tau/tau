import { useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ThemePreset } from '@tau/shared'
import { isHttpResponseError } from '@tau/client-core'
import type { useTheme } from '../../providers/ThemeProvider'
import { client } from '../../api/clientInstance'
import { queries } from '../../queryOptions'
import { themePresetQueryKeys } from '../../queryKeys'
import { BUILT_IN_THEMES, findWebTheme } from '../../theme/registry'
import { applyResolvedTheme } from '../../theme/apply'
import { applyCustomTheme, exportCustomTheme, importCustomTheme, removeCustomProperties } from '../../theme/custom'
import { CustomThemeEditor } from './CustomThemeEditor'

type EditorTarget = { preset: ThemePreset | null; baseId: string }

function errorMessage(error: unknown, fallback: string): string {
  if (isHttpResponseError(error, 409)) return 'This theme changed elsewhere — reload it before trying again.'
  return error instanceof Error ? error.message : fallback
}

/** One preset's swatch, painted from its own compiled document (not a hover
 * preview) — the same DOM-only paint path as everything else in the theme system. */
function PresetSwatch({ preset, currentAppearance }: { preset: ThemePreset; currentAppearance: 'light' | 'dark' }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const theme = findWebTheme(preset.document.base)
    const appearance = theme.kind === 'unified' ? 'constant' : currentAppearance
    removeCustomProperties(element)
    applyResolvedTheme(element, theme, appearance)
    try {
      applyCustomTheme(element, preset.document, appearance)
    } catch {
      removeCustomProperties(element)
    }
  }, [preset, currentAppearance])
  return <span ref={ref} data-theme-scope="" className="theme-swatch block h-8 w-8 shrink-0 rounded-full" />
}

export function ThemePresetLibrary({ value }: { value: ReturnType<typeof useTheme> }) {
  const { data: presets = [] } = useQuery(queries.themePresets.list())
  const cache = useQueryClient()
  const [editing, setEditing] = useState<EditorTarget | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [newBase, setNewBase] = useState(BUILT_IN_THEMES[0]!.id)
  const [notice, setNotice] = useState('')

  const invalidate = () => void cache.invalidateQueries({ queryKey: themePresetQueryKeys.all })

  const duplicate = useMutation({
    mutationFn: (preset: ThemePreset) =>
      client.themePresets.create({ ...preset.document, name: `${preset.document.name} copy`.slice(0, 40) }),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error, 'Duplicate failed.')),
  })
  const rename = useMutation({
    mutationFn: ({ preset, name }: { preset: ThemePreset; name: string }) =>
      client.themePresets.update(preset.id, preset.revision, { ...preset.document, name }),
    onSuccess: (updated) => {
      invalidate()
      if (value.presetId === updated.id) value.applyPreset(updated)
      setRenaming(null)
    },
    onError: (error) => setNotice(errorMessage(error, 'Rename failed.')),
  })
  const remove = useMutation({
    // Deleting a preset that is someone's active selection does not break
    // them: the applied document snapshot stays in ThemeProvider state, and
    // presetId simply dangles — the UI just treats it as detached.
    mutationFn: (preset: ThemePreset) => client.themePresets.delete(preset.id, preset.revision),
    onSuccess: invalidate,
    onError: (error) => setNotice(errorMessage(error, 'Delete failed.')),
  })

  const download = (preset: ThemePreset) => {
    try {
      const url = URL.createObjectURL(new Blob([exportCustomTheme(preset.document)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${preset.document.name || 'tau-custom-theme'}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Export failed.')
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-3 text-sm">
      <h4 className="font-medium text-primary">My themes</h4>
      {presets.length === 0 && <p className="text-secondary">You have no saved theme presets yet.</p>}
      <ul className="flex flex-col gap-2">
        {presets.map((preset) => {
          const active = value.presetId === preset.id
          return (
            <li
              key={preset.id}
              className={clsx(
                'flex flex-wrap items-center gap-2 rounded-lg border p-2',
                active ? 'border-accent' : 'border-th-border'
              )}
            >
              <PresetSwatch preset={preset} currentAppearance={value.theme} />
              {renaming?.id === preset.id ? (
                <form
                  className="flex items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault()
                    rename.mutate({ preset, name: renaming.name })
                  }}
                >
                  <input
                    className="tau-field px-2 py-1"
                    autoFocus
                    maxLength={40}
                    value={renaming.name}
                    onChange={(event) => setRenaming({ id: preset.id, name: event.target.value })}
                  />
                  <button className="tau-button min-h-[36px] px-2 py-1 tau-button-primary" type="submit">
                    Save
                  </button>
                  <button
                    className="tau-button min-h-[36px] px-2 py-1 tau-button-secondary"
                    type="button"
                    onClick={() => setRenaming(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <span className="flex-1 font-medium">
                  {preset.document.name} {active && <span className="text-secondary">(active)</span>}
                </span>
              )}
              <div className="flex flex-wrap gap-1">
                <button
                  className="tau-button min-h-[36px] px-2 py-1 tau-button-secondary"
                  disabled={active}
                  onClick={() => value.applyPreset(preset)}
                >
                  Use
                </button>
                <button
                  className="tau-button min-h-[36px] px-2 py-1 tau-button-secondary"
                  onClick={() => setEditing({ preset, baseId: preset.document.base })}
                >
                  Edit
                </button>
                <button
                  className="tau-button min-h-[36px] px-2 py-1 tau-button-secondary"
                  onClick={() => setRenaming({ id: preset.id, name: preset.document.name })}
                >
                  Rename
                </button>
                <button
                  className="tau-button min-h-[36px] px-2 py-1 tau-button-secondary"
                  disabled={duplicate.isPending}
                  onClick={() => duplicate.mutate(preset)}
                >
                  Duplicate
                </button>
                <button
                  className="tau-button min-h-[36px] px-2 py-1 tau-button-secondary"
                  onClick={() => download(preset)}
                >
                  Export
                </button>
                <button
                  className="tau-button min-h-[36px] px-2 py-1 tau-button-secondary"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete "${preset.document.name}"? This cannot be undone.`))
                      remove.mutate(preset)
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          New theme base
          <select className="tau-field px-3 py-2" value={newBase} onChange={(event) => setNewBase(event.target.value)}>
            {BUILT_IN_THEMES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary"
          onClick={() => setEditing({ preset: null, baseId: newBase })}
        >
          New theme
        </button>
        <label className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary">
          Import JSON
          <input
            aria-label="Import theme preset JSON"
            type="file"
            accept=".json,application/json"
            className="max-w-full"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              const result = await importCustomTheme(file)
              if (!result.ok) {
                setNotice(result.error)
                return
              }
              try {
                await client.themePresets.create(result.document)
                invalidate()
                setNotice('Imported into your theme library.')
              } catch (error) {
                setNotice(errorMessage(error, 'Import failed.'))
              }
            }}
          />
        </label>
      </div>
      {notice && <p role="status">{notice}</p>}
      {editing && (
        <CustomThemeEditor
          value={value}
          preset={editing.preset}
          baseId={editing.baseId}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
