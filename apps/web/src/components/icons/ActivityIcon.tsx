interface IconProps {
  className?: string
}

/** Pulse/heartbeat glyph for the cross-squad Activity feed nav destination. */
export function ActivityIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  )
}
