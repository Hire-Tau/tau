import type { IconProps } from './types'

export function PuzzleIcon({ className = 'w-5 h-5' }: IconProps) {
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
      <path d="M9 3H4v6a3 3 0 1 1 0 6v5h6a3 3 0 1 1 6 0h4v-6a3 3 0 1 0 0-6V3h-5a3 3 0 1 1-6 0Z" />
    </svg>
  )
}
