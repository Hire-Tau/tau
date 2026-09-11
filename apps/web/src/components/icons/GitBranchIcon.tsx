import type { IconProps } from './types'

export function GitBranchIcon({ className = 'w-5 h-5' }: IconProps) {
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
      <path d="M6 6v12m0-9h8a4 4 0 0 0 4-4 M8 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    </svg>
  )
}
