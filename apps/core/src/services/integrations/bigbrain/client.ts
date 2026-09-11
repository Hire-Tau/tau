import { z } from 'zod'
import { BigbrainError } from './errors'

const MAX_RESPONSE_BYTES = 256 * 1024
const READ_TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 20_000

export type BigbrainFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>
export interface BigbrainClientOptions {
  apiBase: string
  credential: () => string
  fetch?: BigbrainFetch
}
const BoundedString = z.string().max(128 * 1024)
const WhoamiSchema = z.object({ scopes: z.array(z.string().min(1).max(100)).max(100) }).strict()
const SearchHitSchema = z
  .object({
    path: z.string().min(1).max(1_000),
    title: z.string().max(10_000).optional(),
    snippet: z
      .string()
      .max(128 * 1024)
      .optional(),
    score: z.number().finite().optional(),
  })
  .strict()
const SearchSchema = z.object({ hits: z.array(SearchHitSchema).max(50) }).strict()
const NoteSchema = z
  .object({ path: z.string().min(1).max(1_000), title: z.string().max(10_000).optional(), content: BoundedString })
  .strict()
const DropSchema = z.object({ path: z.string().min(1).max(1_000) }).strict()

export type BigbrainWhoami = z.infer<typeof WhoamiSchema>
export type BigbrainSearchHit = z.infer<typeof SearchHitSchema>
export type BigbrainNote = z.infer<typeof NoteSchema>
export type BigbrainDropResult = z.infer<typeof DropSchema>

export class BigbrainClient {
  readonly #base: URL
  readonly #credential: () => string
  readonly #fetch: BigbrainFetch

  constructor(options: BigbrainClientOptions) {
    this.#base = validateBaseUrl(options.apiBase)
    this.#credential = options.credential
    this.#fetch = options.fetch ?? fetch
  }

  validate(): Promise<BigbrainWhoami> {
    return this.#json('GET', '/v1/whoami', WhoamiSchema)
  }
  async search(query: string, limit = 10): Promise<{ hits: BigbrainSearchHit[] }> {
    const q = query.trim()
    if (!q || q.length > 1_000 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BigbrainError('invalid_configuration')
    return this.#json('GET', `/v1/search?q=${encodeURIComponent(q)}&n=${limit}`, SearchSchema)
  }
  getNote(path: string): Promise<BigbrainNote> {
    return this.#json('GET', `/v1/note?path=${encodeURIComponent(safePath(path, true))}`, NoteSchema)
  }
  getMemory(path?: string): Promise<string> {
    return this.#text('GET', `/v1/memory${path ? `?path=${encodeURIComponent(safePath(path, false))}` : ''}`)
  }
  dropMarkdown(markdown: string, options: { name?: string; poke?: boolean } = {}): Promise<BigbrainDropResult> {
    if (!markdown || byteLength(markdown) > MAX_RESPONSE_BYTES) throw new BigbrainError('invalid_configuration')
    return this.#json('POST', '/v1/drop', DropSchema, markdown, {
      'content-type': 'text/markdown; charset=utf-8',
      ...(options.name ? { 'x-bigbrain-name': options.name } : {}),
      ...(options.poke === undefined ? {} : { 'x-bigbrain-poke': String(options.poke) }),
    })
  }
  sendSession(
    ndjson: Uint8Array,
    metadata: { session: string; cwd: string; stream: string; fromLine: number }
  ): Promise<void> {
    if (ndjson.byteLength > MAX_RESPONSE_BYTES || metadata.fromLine < 1)
      throw new BigbrainError('invalid_configuration')
    return this.#request('POST', '/v1/session', new Blob([Uint8Array.from(ndjson)]), {
      'content-type': 'application/x-ndjson',
      'x-bigbrain-session': metadata.session,
      'x-bigbrain-cwd': metadata.cwd,
      'x-bigbrain-stream': metadata.stream,
      'x-bigbrain-from-line': String(metadata.fromLine),
    }).then(() => undefined)
  }

  async #json<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: BodyInit,
    headers?: Record<string, string>
  ): Promise<T> {
    const response = await this.#request(method, path, body, headers)
    try {
      const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(response)))
      if (!parsed.success) throw new BigbrainError('invalid_response')
      return parsed.data
    } catch (error) {
      if (error instanceof BigbrainError) throw error
      throw new BigbrainError('invalid_response')
    }
  }
  async #text(method: string, path: string): Promise<string> {
    return new TextDecoder().decode(await this.#request(method, path))
  }
  async #request(
    method: string,
    path: string,
    body?: BodyInit,
    headers: Record<string, string> = {}
  ): Promise<Uint8Array> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.#fetch(new URL(path, this.#base), {
        method,
        body,
        headers: { ...headers, authorization: `Bearer ${this.#credential()}` },
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      throw new BigbrainError(error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'unavailable')
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401) throw new BigbrainError('invalid_auth')
    if (response.status === 403) throw new BigbrainError('missing_scope')
    if (response.status === 429)
      throw new BigbrainError('rate_limited', parseRetryAfter(response.headers.get('retry-after')))
    if (!response.ok) throw new BigbrainError('unavailable')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new BigbrainError('response_too_large')
    const reader = response.body?.getReader()
    if (!reader) return new Uint8Array()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new BigbrainError('response_too_large')
      }
      chunks.push(value)
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
}

export function validateBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BigbrainError('invalid_configuration')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new BigbrainError('invalid_configuration')
  url.pathname = url.pathname.replace(/\/$/, '') + '/'
  return url
}
function safePath(value: string, markdown: boolean): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    (markdown && !value.endsWith('.md'))
  )
    throw new BigbrainError('invalid_configuration')
  return value
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, 60_000) : undefined
}
