interface IconProps {
  className?: string
}

export function PauseIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <rect x="2" y="2" width="2" height="8" rx="0.5" />
      <rect x="8" y="2" width="2" height="8" rx="0.5" />
    </svg>
  )
}
