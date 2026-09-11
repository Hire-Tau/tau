/** Safe, display-only projection of the runtime model registry. */
export interface ModelCatalogEntry {
  provider: string
  id: string
  name: string
  reasoning: boolean
  input: ('text' | 'image')[]
  contextWindow: number
  maxTokens: number
}
