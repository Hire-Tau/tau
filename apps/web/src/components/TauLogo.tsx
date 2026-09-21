import { useId } from 'react'

interface TauLogoProps {
  className?: string
}

export function TauLogo({ className = 'w-8 h-8' }: TauLogoProps) {
  const gradientId = useId()
  return (
    <svg className={className} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="rgb(var(--brand-gradient-from))" />
          <stop offset="100%" stopColor="rgb(var(--brand-gradient-to))" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="76" fill="rgb(var(--brand-tile))" />
      <rect width="512" height="512" rx="76" fill={`url(#${gradientId})`} />
      <text
        x="256"
        y="340"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="280"
        fontWeight="bold"
        fill="rgb(var(--brand-ink))"
        textAnchor="middle"
      >
        τ
      </text>
    </svg>
  )
}
