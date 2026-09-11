import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { apiUrl } from '../api/client'
import { queries } from '../queryOptions'

function toApiImageUrl(path: string): string {
  return apiUrl(path.replace(/^\/api/, ''))
}

export function useImageSrcs(ids: string[]): Record<string, string> {
  const stableIds = useMemo(() => [...new Set(ids)].sort(), [ids])
  const { data } = useQuery(queries.images.signedUrls(stableIds))

  return useMemo(() => {
    const srcs: Record<string, string> = {}
    for (const id of ids) {
      const signedPath = data?.[id]
      srcs[id] = signedPath ? toApiImageUrl(signedPath) : apiUrl(`/images/${id}`)
    }
    return srcs
  }, [ids, data])
}
