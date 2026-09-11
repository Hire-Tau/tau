interface IconProps {
  className?: string
}

export function SparklesIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m10 3 2.4 6.6L19 12l-6.6 2.4L10 21l-2.4-6.6L1 12l6.6-2.4L10 3Z" />
      <path d="m20 2 .8 2.2L23 5l-2.2.8L20 8l-.8-2.2L17 5l2.2-.8L20 2Z" />
    </svg>
  )
}
