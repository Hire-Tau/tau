import { apiFetch } from './client'

export interface MemorySearchResult {
  documentId: string
  sourceSquadId: string
  sourceType: string | null
  sensitivity: string
  path: string | null
  title: string | null
  score: number
  snippet: string
  chunkIndex: number
}

export interface SearchMemoryParams {
  query: string
  limit?: number
  sourceTypes?: string[]
  kinds?: string[]
  tags?: string[]
  paths?: string[]
  sourceSquadIds?: string[]
  sensitivity?: string
}

export async function searchMemory(
  squadId: string,
  params: SearchMemoryParams,
  fetch: typeof apiFetch = apiFetch
): Promise<MemorySearchResult[]> {
  const qs = new URLSearchParams({ query: params.query })
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.sourceTypes?.length) qs.set('sourceTypes', params.sourceTypes.join(','))
  if (params.kinds?.length) qs.set('kinds', params.kinds.join(','))
  if (params.tags?.length) qs.set('tags', params.tags.join(','))
  if (params.paths?.length) qs.set('paths', params.paths.join(','))
  if (params.sourceSquadIds?.length) qs.set('sourceSquadIds', params.sourceSquadIds.join(','))
  if (params.sensitivity) qs.set('sensitivity', params.sensitivity)
  return fetch<MemorySearchResult[]>(`/memory/${squadId}/search?${qs}`)
}
