/**
 * Displays an image from a squad's workspace.
 * Fetches via the workspace download API with auth and renders as an img.
 */

import { useEffect, useRef, useState } from 'react'
import { getSquadWorkspaceDownloadUrl } from '../api/workspace'
import { authFetch } from '../api/client'
import { LoadingSurface, SkeletonBlock } from './loading/Skeleton'

export interface SquadWorkspaceImageViewerProps {
  squadId: string
  filePath: string
  className?: string
}

export function SquadWorkspaceImageViewer({ squadId, filePath, className }: SquadWorkspaceImageViewerProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    const downloadUrl = getSquadWorkspaceDownloadUrl(squadId, filePath)

    authFetch(downloadUrl)
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load image')
        return response.blob()
      })
      .then((blob) => {
        const url = window.URL.createObjectURL(blob)
        urlRef.current = url
        setImageUrl(url)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })

    return () => {
      if (urlRef.current) {
        window.URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [squadId, filePath])

  if (loading) {
    return (
      <LoadingSurface label="Loading image" className="flex h-full min-h-48 w-full items-center justify-center">
        <SkeletonBlock className="h-full min-h-48 w-full rounded-lg" />
      </LoadingSurface>
    )
  }

  if (error) {
    return <div className="text-status-danger-500">Failed to load image: {error}</div>
  }

  return (
    <img
      src={imageUrl || ''}
      alt={filePath.split('/').pop() || 'Image'}
      className={className ?? 'max-w-full max-h-full object-contain'}
    />
  )
}
