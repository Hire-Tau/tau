import type { IconProps } from './types'

export function WorkflowIcon({ className = 'w-5 h-5' }: IconProps) {
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
      <path d="M9 3h6v6H9V3ZM3 15h6v6H3v-6ZM15 15h6v6h-6v-6ZM12 9v3M6 15v-3h12v3" />
    </svg>
  )
}
