import type { IconProps } from './types'

export function SendIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" />
    </svg>
  )
}
