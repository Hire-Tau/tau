interface IconProps {
  className?: string
}

export function MinimizeIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5v4m0 0h-4m4 0l-5-5m11 1v4m0 0h4m-4 0l5-5M9 19v-4m0 0h-4m4 0l-5 5m11-1v-4m0 0h4m-4 0l5 5"
      />
    </svg>
  )
}
