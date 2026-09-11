import { createHash } from 'crypto'
import { closeSync, constants, fchmodSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import { createLogger } from '../../lib/infra/logger'
import { descriptorRelativeFs as descriptor } from './materialize'

const log = createLogger('attachment-blob-storage')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COLLECTION = 'agent-file-attachments'

function normalizeUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${label} id`)
  return value.toLowerCase()
}

export function agentAttachmentBlobPath(agentId: string, attachmentId: string): string {
  return join(getHomeDir(), COLLECTION, normalizeUuid(agentId, 'agent'), normalizeUuid(attachmentId, 'attachment'))
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface BlobStorageTestHooks {
  afterAgentDirectoryOpened?: () => Promise<void>
  afterPrePublishValidation?: (stagingBasename: string) => Promise<void>
}

export async function writeAgentAttachmentBlob(
  agentId: string,
  attachmentId: string,
  bytes: Uint8Array,
  testHooks: BlobStorageTestHooks = {}
): Promise<string> {
  const homePath = getHomeDir()
  const normalizedAgentId = normalizeUuid(agentId, 'agent')
  const normalizedAttachmentId = normalizeUuid(attachmentId, 'attachment')
  const collectionPath = join(homePath, COLLECTION)
  const agentPath = join(collectionPath, normalizedAgentId)
  const finalPath = join(agentPath, normalizedAttachmentId)
  let published = false
  const home = openSync(homePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    descriptor.assertHeldPath(home, homePath)
    descriptor.mkdirAt(home, COLLECTION)
    const collectionIdentity = descriptor.pathIdentity(collectionPath)
    const collection = descriptor.openHeldDirectory(home, homePath, COLLECTION, collectionIdentity)
    try {
      descriptor.mkdirAt(collection, normalizedAgentId)
      const agentIdentity = descriptor.pathIdentity(agentPath)
      const directory = descriptor.openHeldDirectory(collection, collectionPath, normalizedAgentId, agentIdentity)
      try {
        await testHooks.afterAgentDirectoryOpened?.()
        descriptor.assertHeldPath(directory, agentPath)
        const temporary = descriptor.createTemporaryFile(homePath)
        let stagingAnchored = false
        let stagingRemoved = false
        let finalCreated = false
        let finalFd = -1
        try {
          fchmodSync(temporary.fd, 0o600)
          const temporaryIdentity = descriptor.heldIdentity(temporary.fd)
          const stagingFd = descriptor.openAt(
            home,
            temporary.basename,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
          )
          try {
            descriptor.assertHeldIdentity(stagingFd, temporaryIdentity)
            descriptor.assertHeldPath(stagingFd, temporary.path)
            stagingAnchored = true
          } finally {
            closeSync(stagingFd)
          }
          writeFileSync(temporary.fd, bytes)
          fsyncSync(temporary.fd)
          descriptor.assertHeldPath(home, homePath)
          descriptor.assertHeldPath(collection, collectionPath)
          descriptor.assertHeldPath(directory, agentPath)
          descriptor.assertHeldPath(temporary.fd, temporary.path)
          if (testHooks.afterPrePublishValidation) {
            await testHooks.afterPrePublishValidation(temporary.basename)
          }
          finalCreated = descriptor.linkTemporaryFile(temporary, home, directory, normalizedAttachmentId)
          if (!finalCreated) {
            descriptor.unlinkStagingAt(home, temporary.basename)
            stagingRemoved = true
            throw Object.assign(new Error('ATTACHMENT_BLOB_EXISTS'), { code: 'EEXIST' })
          }
          finalFd = descriptor.openAt(
            directory,
            normalizedAttachmentId,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
          )
          descriptor.assertSafeRegularFile(finalFd, bytes.byteLength)
          descriptor.assertHeldIdentity(finalFd, temporaryIdentity)
          published = true
          try {
            descriptor.unlinkStagingAt(home, temporary.basename)
            stagingRemoved = true
          } catch (error) {
            // The immutable final is already committed; metadata must not roll back.
            log.warn('Published attachment blob but could not remove staging link:', error)
          }
          return finalPath
        } catch (error) {
          const cleanupErrors: unknown[] = []
          if (!stagingRemoved) {
            try {
              if (stagingAnchored) descriptor.unlinkStagingAt(home, temporary.basename)
              else unlinkSync(temporary.path)
            } catch (failure) {
              cleanupErrors.push(failure)
            }
          }
          if (finalCreated && !published) {
            try {
              descriptor.unlinkAt(directory, normalizedAttachmentId)
            } catch (failure) {
              cleanupErrors.push(failure)
            }
          }
          if (cleanupErrors.length) {
            throw new AggregateError([error, ...cleanupErrors], 'Attachment blob cleanup failed')
          }
          throw error
        } finally {
          descriptor.closeMaterializationDescriptors([finalFd, temporary.fd], published)
        }
      } finally {
        descriptor.closeMaterializationDescriptors([directory], published)
      }
    } finally {
      descriptor.closeMaterializationDescriptors([collection], published)
    }
  } finally {
    descriptor.closeMaterializationDescriptors([home], published)
  }
}

function openBlobDescriptors(
  agentId: string,
  attachmentId: string,
  includeFile = true
): {
  home: number
  collection: number
  directory: number
  file: number
} {
  const homePath = getHomeDir()
  const normalizedAgentId = normalizeUuid(agentId, 'agent')
  const normalizedAttachmentId = normalizeUuid(attachmentId, 'attachment')
  const collectionPath = join(homePath, COLLECTION)
  const home = openSync(homePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    descriptor.assertHeldPath(home, homePath)
    const collection = descriptor.openHeldDirectory(home, homePath, COLLECTION)
    try {
      const directory = descriptor.openHeldDirectory(collection, collectionPath, normalizedAgentId)
      try {
        const file = includeFile
          ? descriptor.openAt(
              directory,
              normalizedAttachmentId,
              constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
            )
          : -1
        return { home, collection, directory, file }
      } catch (error) {
        closeSync(directory)
        throw error
      }
    } catch (error) {
      closeSync(collection)
      throw error
    }
  } catch (error) {
    closeSync(home)
    throw error
  }
}

export async function readVerifiedAgentAttachmentBlob(
  agentId: string,
  attachmentId: string,
  byteSize: number,
  sha256: string
): Promise<Buffer> {
  const opened = openBlobDescriptors(agentId, attachmentId)
  try {
    descriptor.assertSafeRegularFile(opened.file, byteSize)
    const bytes = readFileSync(opened.file)
    if (sha256Hex(bytes) !== sha256) throw new Error('ATTACHMENT_BLOB_CORRUPT')
    return bytes
  } catch (error) {
    if (error instanceof Error && error.message === 'ATTACHMENT_MATERIALIZATION_CONFLICT') {
      throw new Error('ATTACHMENT_BLOB_CORRUPT')
    }
    throw error
  } finally {
    descriptor.closeMaterializationDescriptors([opened.file, opened.directory, opened.collection, opened.home], false)
  }
}

export async function deleteAgentAttachmentBlob(agentId: string, attachmentId: string): Promise<void> {
  const opened = openBlobDescriptors(agentId, attachmentId, false)
  try {
    descriptor.unlinkAt(opened.directory, normalizeUuid(attachmentId, 'attachment'))
  } finally {
    descriptor.closeMaterializationDescriptors([opened.file, opened.directory, opened.collection, opened.home], false)
  }
}
