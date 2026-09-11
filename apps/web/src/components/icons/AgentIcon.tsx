import type { IconProps } from './types'

export function AgentIcon({ className = 'w-5 h-5' }: IconProps) {
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
      <rect x="5" y="7" width="14" height="13" rx="3" />
      <path d="M12 3v4M2 12v4m20-4v4M9 16h6" />
      <circle cx="9" cy="12" r=".75" fill="currentColor" />
      <circle cx="15" cy="12" r=".75" fill="currentColor" />
    </svg>
  )
}
