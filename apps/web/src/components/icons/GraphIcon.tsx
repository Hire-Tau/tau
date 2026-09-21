import type { IconProps } from './types'

/** Three nodes joined by edges — the dependency-graph view of active work. */
export function GraphIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.5 6h7M7.3 8.2l3.5 7.6M16.7 8.2l-3.5 7.6" />
    </svg>
  )
}
