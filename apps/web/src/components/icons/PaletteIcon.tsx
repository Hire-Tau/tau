interface IconProps {
  className?: string
}

export function PaletteIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 3a9 9 0 100 18c1.105 0 2-.85 2-1.9 0-.5-.207-.95-.545-1.3a1.8 1.8 0 01-.545-1.3c0-1.05.895-1.9 2-1.9h2.1c1.63 0 2.99-1.31 2.99-2.93C19.999 6.999 16.418 3 12 3z"
      />
      <circle cx="7.5" cy="10.5" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="7" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="7" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="10.5" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  )
}
