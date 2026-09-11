interface TauLogoProps {
  className?: string
}

export function TauLogo({ className = 'w-8 h-8' }: TauLogoProps) {
  return (
    <svg className={className} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="tau-logo-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="76" fill="url(#tau-logo-grad)" />
      <text
        x="256"
        y="340"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="280"
        fontWeight="bold"
        fill="white"
        textAnchor="middle"
      >
        τ
      </text>
    </svg>
  )
}
