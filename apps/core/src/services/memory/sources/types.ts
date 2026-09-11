export interface IndexResult {
  success: boolean
  documentId?: string
  chunksCreated: number
  chunksPreserved?: number
  linksCreated: number
  skipped?: boolean
  reason?: string
  error?: string
}
