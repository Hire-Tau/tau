import type { IconProps } from './types'

export function KeyIcon({ className = 'w-5 h-5' }: IconProps) {
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
      <path d="M14 4a5 5 0 1 1-3 9l-7 7H2v-4l7-7a5 5 0 0 1 5-5ZM16 8h.01M5 13l3 3" />
    </svg>
  )
}
