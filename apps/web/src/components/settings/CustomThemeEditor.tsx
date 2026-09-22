import { useLayoutEffect, useRef, useState } from 'react'
import { ACTIVE_THEME_TOKENS, STATUS_TOKENS, validateCustomTheme, type CustomThemeDocument } from '@tau/shared'
import type { useTheme } from '../../providers/ThemeProvider'
import { BUILT_IN_THEMES, findWebTheme } from '../../theme/registry'
import {
  applyCustomTheme,
  exportCustomTheme,
  importCustomTheme,
  readPreviewTokens,
  removeCustomProperties,
} from '../../theme/custom'
import { applyResolvedTheme } from '../../theme/apply'
import { contrast, contrastPairs, pairBackground, tokenRgba, type ContrastPair } from '../../theme/contrast'

interface Warning {
  pair: ContrastPair
  ratio: number | null
  safe: string | null
}

export function CustomThemeEditor({ value }: { value: ReturnType<typeof useTheme> }) {
  const [draft, setDraft] = useState<CustomThemeDocument>(
    () =>
      value.customTheme ?? {
        format: 'tau-custom-theme',
        version: 1,
        name: 'My theme',
        base: value.themeId,
        appearance: findWebTheme(value.themeId).kind === 'unified' ? 'constant' : value.theme,
        overrides: {},
      }
  )
  const [token, setToken] = useState(ACTIVE_THEME_TOKENS[0]!)
  const [color, setColor] = useState('#336699')
  const [notice, setNotice] = useState('')
  const [warnings, setWarnings] = useState<Warning[]>([])
  const [previewError, setPreviewError] = useState('')
  const preview = useRef<HTMLDivElement>(null)
  const baseTokens = useRef<Record<string, string>>({})
  const validation = validateCustomTheme(JSON.stringify(draft), BUILT_IN_THEMES)
  const base = findWebTheme(draft.base)

  useLayoutEffect(() => {
    const element = preview.current!
    removeCustomProperties(element)
    applyResolvedTheme(element, findWebTheme(draft.base), draft.appearance)
    baseTokens.current = readPreviewTokens(element)
    const result = validateCustomTheme(JSON.stringify(draft), BUILT_IN_THEMES)
    setPreviewError('')
    setWarnings([])
    if (!result.ok) return
    try {
      applyCustomTheme(element, result.document)
    } catch {
      removeCustomProperties(element)
      setPreviewError('Preview could not be applied. The page theme has not changed.')
      return
    }
    try {
      const tokens = readPreviewTokens(element)
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
  }, [draft])

  const override = (name: string, nextColor: string) => {
    const overrides = { ...draft.overrides }
    if (STATUS_TOKENS.includes(name) && !STATUS_TOKENS.every((key) => key in overrides)) {
      // The editor helps author the atomic status grid; importer never fills it
      // silently before validation. Built-in status RGB channels are integers.
      try {
        for (const key of STATUS_TOKENS) {
          const parts = baseTokens.current[key]!.split('/').map((part) => part.trim())
          const rgb = parts[0]!.split(/\s+/).map(Number).map(Math.round).join(', ')
          overrides[key] = parts[1] ? `rgba(${rgb}, ${Number(parts[1])})` : `rgb(${rgb})`
        }
      } catch {
        setNotice('Status base values are not available. Try reopening the editor.')
        return
      }
    }
    overrides[name] = nextColor
    setDraft({ ...draft, overrides })
  }
  const remove = (name: string) => {
    const overrides = { ...draft.overrides }
    for (const key of STATUS_TOKENS.includes(name) ? STATUS_TOKENS : [name]) delete overrides[key]
    setDraft({ ...draft, overrides })
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

  return (
    <div className="mt-4 flex flex-col gap-3 text-sm">
      <p className="text-secondary">
        Single-appearance theme. Preview stays on this device and changes only the sample below. Apply changes the app
        and syncs the theme to your account when signed in. Switching the built-in theme or appearance clears custom
        overrides.
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
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">
          Base theme
          <select
            className="tau-field px-3 py-2"
            value={draft.base}
            onChange={(event) => {
              const next = findWebTheme(event.target.value)
              setDraft({ ...draft, base: next.id, appearance: next.kind === 'unified' ? 'constant' : 'light' })
            }}
          >
            {BUILT_IN_THEMES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Custom appearance
          <select
            className="tau-field px-3 py-2"
            value={draft.appearance}
            disabled={base.kind === 'unified'}
            onChange={(event) =>
              setDraft({ ...draft, appearance: event.target.value as CustomThemeDocument['appearance'] })
            }
          >
            {base.kind === 'unified' ? (
              <option value="constant">Constant</option>
            ) : (
              <>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </>
            )}
          </select>
        </label>
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
        restores that entire set. Inherited sentinels and opacity are preserved.
      </p>
      <button
        className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary self-start"
        onClick={() => override(token, color)}
      >
        Preview token
      </button>
      <ul className="max-h-48 overflow-auto">
        {Object.entries(draft.overrides).map(([name, color]) => (
          <li key={name} className="flex flex-wrap items-center gap-2 py-1">
            <span>
              {name}: {color}
            </span>
            <button
              className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary"
              aria-label={`Remove ${name}`}
              onClick={() => remove(name)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {!validation.ok && <p role="alert">{validation.error}</p>}
      {previewError && <p role="alert">{previewError}</p>}
      <div
        ref={preview}
        data-theme-scope=""
        aria-label="Custom theme preview"
        className="rounded-lg p-4 bg-page text-primary border border-default"
      >
        <div aria-label="Preview surface" className="rounded-lg p-4 bg-surface">
          <h4 className="font-medium">Preview: {draft.name}</h4>
          <p className="text-secondary">
            Secondary text <span className="text-muted">and muted text</span>
          </p>
          <button className="tau-button min-h-[44px] px-3 py-2 tau-button-primary mt-2" type="button">
            Sample action
          </button>
          <p className="mt-2 text-[rgb(var(--status-danger-fg))]">Error status</p>
          <pre className="mt-2 p-2 bg-[rgb(var(--syntax-bg))] text-[rgb(var(--syntax-comment))]">// Syntax comment</pre>
          <p className="bg-[rgb(var(--term-bg))] text-[rgb(var(--term-fg))]">Terminal sample</p>
          <p className="bg-[rgb(var(--graph-bg))] text-[rgb(var(--graph-label))]">Graph label</p>
        </div>
      </div>
      {warnings.length > 0 && (
        <div aria-label="Contrast warnings" className="max-h-64 overflow-auto">
          <p>
            Informational contrast warnings — these do not block Apply. Surfaces are checked over the preview surface
            and page; a translucent page may have an unknown backdrop.
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
      <div className="flex flex-wrap gap-2">
        <button
          className="tau-button min-h-[44px] px-3 py-2 tau-button-primary"
          disabled={!validation.ok || !!previewError}
          onClick={() => {
            try {
              value.applyCustom(draft)
              setNotice('Custom theme applied.')
            } catch (error) {
              setNotice(error instanceof Error ? error.message : 'Apply failed.')
            }
          }}
        >
          Apply custom theme
        </button>
        <button
          className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary"
          disabled={!validation.ok}
          onClick={download}
        >
          Export JSON
        </button>
        <label className="tau-button min-h-[44px] px-3 py-2 tau-button-secondary">
          Import JSON
          <input
            aria-label="Import theme JSON"
            type="file"
            accept=".json,application/json"
            className="max-w-full"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              try {
                const result = await importCustomTheme(file)
                if (!result.ok) setNotice(result.error)
                else {
                  setDraft(result.document)
                  setNotice(result.warnings.join(' ') || 'Imported for preview. Apply to confirm.')
                }
              } catch {
                setNotice('Could not read the theme file.')
              }
            }}
          />
        </label>
      </div>
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
