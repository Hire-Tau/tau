import type { ReactNode } from 'react'
import { usePermissions } from '../hooks/usePermissions'

interface CanProps {
  permission: string
  squadId?: string
  children: ReactNode
  fallback?: ReactNode
}

/**
 * Render children only when the current identity holds `permission`.
 *
 * Permission checks are UX-only; backend guards remain authoritative. While the
 * permission query is loading or failed, this component degrades closed by
 * rendering the fallback (null by default).
 */
export function Can({ permission, squadId, children, fallback = null }: CanProps) {
  const { can, isLoading, isError } = usePermissions(squadId)

  if (isLoading || isError) return <>{fallback}</>
  return can(permission) ? <>{children}</> : <>{fallback}</>
}
