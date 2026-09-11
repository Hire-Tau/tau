interface IconProps {
  className?: string
}

export function AutoScrollIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {/* Down arrow */}
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v12m0 0l-5-5m5 5l5-5" />
      {/* Bottom line */}
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20h10" />
    </svg>
  )
}
