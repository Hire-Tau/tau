interface IconProps {
  className?: string
}

export function ReturnRouteIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
