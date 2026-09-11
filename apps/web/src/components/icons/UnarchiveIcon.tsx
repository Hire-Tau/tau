interface IconProps {
  className?: string
}

export function UnarchiveIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 6h18m-9 8v6m-3-3l3 3 3-3" />
    </svg>
  )
}
