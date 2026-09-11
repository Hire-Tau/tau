import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { useMutation as useMutationActual, useQueryClient as useQueryClientActual } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { ReactQueryHooksProvider } from '../../reactQueryHooks'
import type { SettingMetadata } from '../../api/settings'
import { SettingsApiProvider } from './settingsApi'

/**
 * Tests for the CONTAINER half of the concurrency-cap control.
 *
 * `NumberSettingFields` (the presentational half, covered in
 * FeaturesSection.test.tsx) renders whatever it is handed. Everything that
 * decides WHAT it is handed lives here: the draft state, the trim applied on
 * save, which settings key the writes target, that "Reset to default" issues a
 * DELETE rather than a write, and the effect that re-seeds the draft when the
 * server value changes underneath it. None of that is reachable through the
 * presentational component, and all of it is behaviour an operator would feel
 * — a lost trim sends ' 42 ' to a validator that rejects it; a wrong key writes
 * the wrong setting; a missing re-seed leaves a stale number in the box after a
 * save lands.
 *
 * Mocking notes. The react-query hooks are overridden through
 * `ReactQueryHooksProvider`, which is scoped to this render tree, so nothing
 * downstream of this file inherits them regardless of file order. Settings API
 * overrides are likewise scoped to this render tree through `SettingsApiProvider`.
 *
 * The `useMutation` stand-in is deliberately thin but faithful on the one axis
 * under test: `mutate()` invokes the real `mutationFn` the component supplied,
 * so the assertions below observe the component's own wiring rather than a
 * re-implementation of it.
 */

const setSetting = mock((_key: string, _value: string) => Promise.resolve())
const deleteSetting = mock((_key: string) => Promise.resolve())

const invalidateQueries = mock((_options: { queryKey: readonly unknown[] }) => undefined)

interface MutationConfig<V> {
  mutationFn: (vars: V) => Promise<unknown>
  onSuccess?: () => unknown
}

function useMutation<V>(config: MutationConfig<V>) {
  return {
    mutate: (vars: V) => {
      void Promise.resolve(config.mutationFn(vars)).then(() => config.onSuccess?.())
    },
    reset: () => {},
    isPending: false,
    error: null,
  }
}

const hookOverrides = {
  useQueryClient: (() => ({ invalidateQueries })) as unknown as typeof useQueryClientActual,
  useMutation: useMutation as unknown as typeof useMutationActual,
}

const KEY = 'MAX_CONCURRENT_AGENTS'
const LABEL = 'Max Concurrent Agents'

function capSetting(overrides: Partial<SettingMetadata> = {}): SettingMetadata {
  return {
    key: KEY,
    value: '20',
    type: 'number',
    default: '20',
    description: 'Maximum agent executions this instance runs concurrently (1-500).',
    isDefault: false,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'admin',
    ...overrides,
  }
}

describe('NumberSetting container', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let container: HTMLDivElement
  let root: import('react-dom/client').Root
  let NumberSetting: typeof import('./FeaturesSection').NumberSetting
  let NumberSettingFields: typeof import('./FeaturesSection').NumberSettingFields

  beforeEach(async () => {
    setSetting.mockClear()
    deleteSetting.mockClear()
    invalidateQueries.mockClear()
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    Object.assign(dom.window, { SyntaxError })
    ;({ NumberSetting, NumberSettingFields } = await import('./FeaturesSection'))
    ;({ root, container } = dom.createRoot())
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  async function render(setting: SettingMetadata): Promise<void> {
    await dom.act(async () => {
      root.render(
        <ReactQueryHooksProvider hooks={hookOverrides}>
          <SettingsApiProvider api={{ setSetting, deleteSetting }}>
            <NumberSetting setting={setting} label={LABEL} canWrite={true} />
          </SettingsApiProvider>
        </ReactQueryHooksProvider>
      )
    })
  }

  function input(): HTMLInputElement {
    const el = container.querySelector('input[type="number"]')
    if (!el) throw new Error('number input not rendered')
    return el as HTMLInputElement
  }

  function button(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))
    if (!found)
      throw new Error(
        `no button containing "${text}" (saw: ${[...container.querySelectorAll('button')].map((b) => b.textContent).join(' | ')})`
      )
    return found as HTMLButtonElement
  }

  async function type(value: string): Promise<void> {
    await dom.act(async () => {
      const el = input()
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, value)
      el.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    })
  }

  async function click(text: string): Promise<void> {
    await dom.act(async () => {
      button(text).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }

  test('seeds the input from the server value', async () => {
    await render(capSetting({ value: '37' }))
    expect(input().value).toBe('37')
  })

  test('native input forwards raw numeric and empty drafts exactly once without changing disabled semantics', async () => {
    const onDraftChange = mock((_value: string) => {})
    await dom.act(async () => {
      root.render(
        <NumberSettingFields
          setting={capSetting()}
          label={LABEL}
          canWrite={true}
          draft="20"
          onDraftChange={onDraftChange}
          onSave={() => {}}
          onReset={() => {}}
          isSaving={false}
          isResetting={false}
        />
      )
    })

    const el = input()
    expect(el.min).toBe('1')
    expect(el.step).toBe('1')
    expect(el.disabled).toBe(false)
    for (const value of ['-4', '999', '']) await type(value)
    expect(onDraftChange.mock.calls).toEqual([['-4'], ['999'], ['']])

    await dom.act(async () => {
      root.render(
        <NumberSettingFields
          setting={capSetting()}
          label={LABEL}
          canWrite={false}
          draft="20"
          onDraftChange={onDraftChange}
          onSave={() => {}}
          onReset={() => {}}
          isSaving={false}
          isResetting={false}
        />
      )
    })
    expect(input().disabled).toBe(true)
    expect(input().getAttribute('aria-disabled')).toBe('true')
  })

  // Mutation caught: dropping `.trim()` from onSave. The server validator runs
  // Number(text) on a trimmed string, but the surrounding whitespace would also
  // make `isDirty` true forever and mask that nothing changed.
  test('trims the draft and writes the key the setting carries', async () => {
    await render(capSetting({ key: 'SOME_OTHER_NUMERIC_SETTING', value: '20' }))
    await type('  42  ')
    expect(input().value).toBe('  42  ')
    expect(button('Save').disabled).toBe(false)
    await click('Save')
    expect(setSetting).toHaveBeenCalledTimes(1)
    expect(setSetting.mock.calls[0]).toEqual(['SOME_OTHER_NUMERIC_SETTING', '42'])
  })

  // Mutation caught: wiring Reset to `setSetting(key, default)` instead of a
  // DELETE. That stores the default as an explicit override, so the setting
  // would stop tracking the env var — the exact fallback "reset" promises.
  test('reset issues a DELETE, never a write', async () => {
    await render(capSetting({ isDefault: false }))
    await click('Reset to default')
    expect(deleteSetting).toHaveBeenCalledTimes(1)
    expect(deleteSetting.mock.calls[0]).toEqual([KEY])
    expect(setSetting).not.toHaveBeenCalled()
  })

  // Mutation caught: dropping the useEffect (or giving it an empty dep array),
  // which strands the input on the pre-save number after the refetch lands.
  test('re-seeds the draft when the server value changes', async () => {
    await render(capSetting({ value: '20' }))
    await type('99')
    expect(input().value).toBe('99')

    await render(capSetting({ value: '55' }))
    expect(input().value).toBe('55')
  })

  // Mutation caught: a dep array of [setting], which is a new object identity on
  // every refetch and would discard an in-progress edit the operator is typing.
  test('a re-render with an unchanged value leaves the operator mid-edit alone', async () => {
    await render(capSetting({ value: '20' }))
    await type('99')
    await render(capSetting({ value: '20' }))
    expect(input().value).toBe('99')
  })

  test('a successful save invalidates the settings cache', async () => {
    await render(capSetting({ value: '20' }))
    await type('42')
    await click('Save')
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.settings.all })
  })
})
