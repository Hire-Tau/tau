import { apiFetch } from './client'

export interface ExtractField {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
  options?: string[]
  suggestions?: string[]
}

export interface ExtractRequest {
  transcript: string
  fields: Record<string, ExtractField>
  context?: string
}

export interface ExtractResponse {
  fields: Record<string, unknown>
}

export async function extractFormFields(request: ExtractRequest): Promise<ExtractResponse> {
  return apiFetch<ExtractResponse>('/ai/extract', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}
