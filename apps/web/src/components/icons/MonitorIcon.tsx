interface IconProps {
  className?: string
}

export function MonitorIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M2 10h3l1.5-5 3 10 2-7 1.5 4H18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.2" opacity="0.35" />
    </svg>
  )
}
