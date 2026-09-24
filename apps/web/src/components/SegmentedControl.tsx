import clsx from 'clsx'
import type { ComponentType } from 'react'

export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  Icon?: ComponentType<{ className?: string }>
}

/**
 * Generic tab-picker radiogroup: a small set of mutually-exclusive text (or
 * icon+text) options in one pill-shaped row. Shared by every segmented choice
 * in the theme system — SegmentedAppearanceControl (Light/Dark/System) and
 * the custom theme editor's Contrast (Standard/High) and Status colors
 * (Static/Harmonized) toggles — so they read as one consistent control
 * instead of three differently-styled button rows.
 */
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  disabled = false,
  hintId,
  className,
}: {
  ariaLabel: string
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (next: T) => void
  disabled?: boolean
  hintId?: string
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={clsx('flex gap-1 rounded-lg bg-surface-secondary p-1', className)}
    >
      {options.map(({ value: optionValue, label, Icon }) => (
        <button
          key={optionValue}
          type="button"
          role="radio"
          aria-checked={value === optionValue}
          disabled={disabled}
          aria-describedby={disabled ? hintId : undefined}
          className={clsx(
            'flex min-h-[36px] flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium',
            disabled
              ? 'cursor-default text-muted opacity-60'
              : value === optionValue
                ? 'bg-accent text-on-accent'
                : 'text-secondary hover:bg-surface-hover'
          )}
          onClick={() => onChange(optionValue)}
        >
          {Icon && <Icon className="h-3.5 w-3.5" />}
          {label}
        </button>
      ))}
    </div>
  )
}
