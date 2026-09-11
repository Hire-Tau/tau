interface IconProps {
  className?: string
}

export function UndoIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 14 4 9l5-5 M4 9h10a6 6 0 0 1 0 12" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
