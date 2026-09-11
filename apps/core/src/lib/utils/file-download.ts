/**
 * File download utilities for workspace routes.
 */
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import archiver from 'archiver'

interface SandboxFileClient {
  stat(request: { path: string }): Promise<{ size: number; isDirectory: boolean }>
  read(request: { path: string; limit?: number }): Promise<{ content: string; totalSize: number }>
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
}

/**
 * Get MIME type for a file extension.
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

/**
 * Create a streaming zip Response for a directory.
 * Streams chunks as they're compressed - doesn't buffer the entire archive in memory.
 */
export function createZipResponse(targetPath: string, defaultName = 'download'): Response {
  const folderName = path.basename(targetPath) || defaultName
  const archive = archiver('zip', { zlib: { level: 5 } })

  // Add the directory and start archiving
  archive.directory(targetPath, false)
  archive.finalize()

  // Convert Node.js stream to Web ReadableStream with proper backpressure
  const webStream = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${folderName}.zip"`,
      'Transfer-Encoding': 'chunked',
    },
  })
}

/**
 * Create a download Response for a sandbox file.
 *
 * Sandbox reads default to a small preview-sized window, so downloads must first
 * stat the file and then request the full byte length to avoid truncating binary
 * attachments such as PDFs and ZIP archives.
 */
export async function createSandboxFileResponse(
  client: SandboxFileClient,
  filePath: string,
  filename = path.basename(filePath)
): Promise<Response> {
  const stat = await client.stat({ path: filePath })
  if (stat.isDirectory) {
    throw new Error('Directory downloads are not supported by sandbox file download')
  }

  const result = await client.read({ path: filePath, limit: stat.size })
  const buffer = Buffer.from(result.content, 'base64')
  const contentType = getMimeType(filename)

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
    },
  })
}

/**
 * Create a download Response for a file.
 */
export function createFileResponse(targetPath: string): Response {
  const buffer = fs.readFileSync(targetPath)
  const fileName = path.basename(targetPath)
  const contentType = getMimeType(targetPath)

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': String(buffer.length),
    },
  })
}

/**
 * Create a download Response for a file or directory.
 * Directories are streamed as zip archives.
 */
export function createDownloadResponse(targetPath: string, defaultName = 'download'): Response {
  const stat = fs.statSync(targetPath)

  if (stat.isDirectory()) {
    return createZipResponse(targetPath, defaultName)
  }

  return createFileResponse(targetPath)
}
