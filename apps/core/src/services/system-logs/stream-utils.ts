import type { SystemLogComponent } from './types'

/**
 * Prefix every complete line in a log chunk with the logical component. This is
 * intentionally chunk-local: log streams are line-oriented, and providers pass
 * through the trailing partial chunk without buffering to keep cancellation
 * simple and latency low.
 */
export function createLinePrefixer(prefix: string): (chunk: Buffer) => Buffer {
  let atLineStart = true

  return (chunk) => {
    const output: Buffer[] = []
    for (const byte of chunk) {
      if (atLineStart) output.push(Buffer.from(prefix))
      output.push(Buffer.from([byte]))
      atLineStart = byte === 10
    }
    return Buffer.concat(output)
  }
}

/** Prefix a standalone chunk. Long-lived streams should use createLinePrefixer. */
export function prefixChunk(component: SystemLogComponent, chunk: Buffer): Buffer {
  return createLinePrefixer(`[${component}] `)(chunk)
}

export async function pumpReadableStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: Buffer) => void,
  onError?: (err: Error) => void
): Promise<void> {
  if (!stream) return
  try {
    for await (const chunk of stream) onChunk(Buffer.from(chunk))
  } catch (err) {
    onError?.(err as Error)
  }
}
