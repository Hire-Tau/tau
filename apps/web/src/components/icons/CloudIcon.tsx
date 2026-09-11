interface IconProps {
  className?: string
}

export function CloudIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3.75 16.5a4.5 4.5 0 0 1 4.33-4.497 6 6 0 0 1 11.48 1.77A3.75 3.75 0 0 1 18.75 21H7.5a3.75 3.75 0 0 1-3.75-4.5Z"
      />
    </svg>
  )
}
