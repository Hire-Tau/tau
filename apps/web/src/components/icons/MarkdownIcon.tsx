interface IconProps {
  className?: string
}

export function MarkdownIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zm2 0v14h14V5H5zm2.5 10V9h2l1.5 2.25L12.5 9h2v6h-2v-2.5l-1.5 2-1.5-2V15h-2zm8 0v-3.5L14 13v-1l2-2h1.5v5H16z" />
    </svg>
  )
}
