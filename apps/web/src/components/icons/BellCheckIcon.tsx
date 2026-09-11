import type { IconProps } from './types'

export function BellCheckIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <g strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h9M10 21h4" />
        <path d="m15 15 2 2 4-4" />
      </g>
    </svg>
  )
}
