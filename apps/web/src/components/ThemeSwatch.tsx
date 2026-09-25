import { useLayoutEffect, useRef } from 'react'
import clsx from 'clsx'
import type { CustomThemeDocument, EffectiveAppearance } from '@tau/shared'
import { findWebTheme, type WebThemeDefinition } from '../theme/registry'
import { applyResolvedTheme } from '../theme/apply'
import { applyCustomTheme, removeCustomProperties } from '../theme/custom'

export type ThemeSwatchSpec =
  | { kind: 'builtin'; theme: WebThemeDefinition; appearance: 'light' | 'dark' }
  | { kind: 'preset'; document: CustomThemeDocument; appearance: EffectiveAppearance }

/**
 * One theme circle's paint: shared by ThemeQuickPicker's circles, the
 * Settings theme grid, and the "My themes" library rows, so the three surfaces
 * can never drift out of sync on how a theme's swatch resolves. See
 * design-system.css's `.theme-swatch` doc comment for why the outline lives
 * in that class as an inset box-shadow rather than a per-caller `border`.
 *
 * A built-in theme paints declaratively: `[data-theme-scope][data-theme][data-appearance]`
 * scoping in builtins.css resolves its real tokens onto this element, so no
 * JS ever computes a built-in's colors. A preset has no static CSS rule (its
 * overrides are an arbitrary per-document palette/token set), so it paints
 * imperatively via the same applyResolvedTheme → applyCustomTheme DOM path
 * the live preview and the custom-theme editor use — falling back to the
 * plain base paint (never a blank circle) if the document fails to apply.
 */
export function ThemeSwatch({
  spec,
  ring,
  className,
}: {
  spec: ThemeSwatchSpec
  /** A picker's ring around the circle, in the circle's own theme colour: `on`, `dim`, or none. */
  ring?: 'on' | 'dim'
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || spec.kind !== 'preset') return
    const base = findWebTheme(spec.document.base)
    removeCustomProperties(element)
    applyResolvedTheme(element, base, spec.appearance)
    try {
      applyCustomTheme(element, spec.document, spec.appearance)
    } catch {
      removeCustomProperties(element)
    }
  }, [spec])

  if (spec.kind === 'builtin')
    return (
      <span
        data-theme-scope=""
        data-theme={spec.theme.id}
        data-appearance={spec.theme.kind === 'unified' ? undefined : spec.appearance}
        data-ring={ring}
        className={clsx('theme-swatch block', className)}
      />
    )
  return <span ref={ref} data-theme-scope="" data-ring={ring} className={clsx('theme-swatch block', className)} />
}
