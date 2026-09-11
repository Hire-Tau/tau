interface IconProps {
  className?: string
}

export function MinusIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
