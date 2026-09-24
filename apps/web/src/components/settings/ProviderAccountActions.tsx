import type { ReactNode } from 'react'
import { OverflowMenu } from '../OverflowMenu'

export function ProviderAccountActions({ label, children }: { label: string; children: ReactNode }) {
  return (
    <OverflowMenu label={`Account options for ${label}`} itemsMarker="data-account-actions">
      {children}
    </OverflowMenu>
  )
}
