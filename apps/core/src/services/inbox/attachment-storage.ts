import { createHash } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getHomeDir } from '../../lib/utils/home'

/** Absolute path for an attachment blob. Dedicated to the inbox, separate from the artifact store. */
export function inboxAttachmentPath(messageId: string, attachmentId: string): string {
  return join(getHomeDir(), 'inbox-attachments', messageId, attachmentId)
}

export async function writeAttachmentFile(messageId: string, attachmentId: string, bytes: Uint8Array): Promise<string> {
  const path = inboxAttachmentPath(messageId, attachmentId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

export async function readAttachmentFile(storagePath: string): Promise<Buffer> {
  return readFile(storagePath)
}

export async function deleteAttachmentFile(storagePath: string): Promise<void> {
  await rm(storagePath, { force: true })
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
