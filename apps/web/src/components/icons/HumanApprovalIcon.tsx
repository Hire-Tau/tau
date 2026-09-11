import type { IconProps } from './types'

export function HumanApprovalIcon({ className = 'w-5 h-5' }: IconProps) {
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
      <circle cx="9" cy="7" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 10-4.5M15 17l2 2 4-5" />
    </svg>
  )
}
