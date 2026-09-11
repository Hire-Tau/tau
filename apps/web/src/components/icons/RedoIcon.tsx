interface IconProps {
  className?: string
}

export function RedoIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m15 14 5-5-5-5 M20 9H10a6 6 0 0 0 0 12" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
