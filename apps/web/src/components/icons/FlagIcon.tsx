import type { IconProps } from './types'

export function FlagIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 21V4m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0" />
    </svg>
  )
}
