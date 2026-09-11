import type { IconProps } from './types'

export function InspectorIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path strokeLinecap="round" d="M10 4v16m4-11h3m-3 4h3" />
    </svg>
  )
}
