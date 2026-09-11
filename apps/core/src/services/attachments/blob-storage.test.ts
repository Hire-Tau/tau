import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  agentAttachmentBlobPath,
  deleteAgentAttachmentBlob,
  readVerifiedAgentAttachmentBlob,
  writeAgentAttachmentBlob,
} from './blob-storage'

const AGENT_ID = '09d1956b-a4aa-4a25-a204-272c771ce474'
const ATTACHMENT_ID = '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d'
let home: string
const originalHome = process.env.HOME_DIR

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-blob-'))
  process.env.HOME_DIR = home
})

afterEach(async () => {
  const entries = await (await import('fs/promises')).readdir(home).catch(() => [])
  expect(entries.filter((name) => name.startsWith('.tau-agent-attachment-'))).toEqual([])
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  await rm(home, { recursive: true, force: true })
})

async function captureRejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    return error as Error
  }
  throw new Error('Expected operation to reject')
}

describe('agent attachment blob storage', () => {
  test('derives paths only from UUIDs', async () => {
    expect(agentAttachmentBlobPath(AGENT_ID, ATTACHMENT_ID)).toBe(
      join(home, 'agent-file-attachments', AGENT_ID, ATTACHMENT_ID)
    )
    expect(() => agentAttachmentBlobPath('../outside', ATTACHMENT_ID)).toThrow('Invalid agent id')
    expect(() => agentAttachmentBlobPath(AGENT_ID, '../outside')).toThrow('Invalid attachment id')
    expect(() => agentAttachmentBlobPath('/tmp/outside', ATTACHMENT_ID)).toThrow('Invalid agent id')
    expect(() => agentAttachmentBlobPath(AGENT_ID, '%2e%2e%2foutside')).toThrow('Invalid attachment id')
    const source = await readFile(join(import.meta.dir, 'blob-storage.ts'), 'utf8')
    expect(source).toContain('if (!UUID_RE.test(value))')
    expect(source).toContain('constants.O_NOFOLLOW')
    expect(source).toContain('descriptor.assertHeldIdentity(finalFd, temporaryIdentity)')
    expect(source).toContain('if (finalCreated && !published)')
  })

  test('normalizes uppercase UUIDs for write and verified read', async () => {
    const uppercaseAgentId = AGENT_ID.toUpperCase()
    const uppercaseAttachmentId = ATTACHMENT_ID.toUpperCase()
    await writeAgentAttachmentBlob(uppercaseAgentId, uppercaseAttachmentId, new TextEncoder().encode('hello'))
    expect(agentAttachmentBlobPath(uppercaseAgentId, uppercaseAttachmentId)).toBe(
      agentAttachmentBlobPath(AGENT_ID, ATTACHMENT_ID)
    )
    expect(
      await readVerifiedAgentAttachmentBlob(
        AGENT_ID,
        ATTACHMENT_ID,
        5,
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      )
    ).toEqual(Buffer.from('hello'))
  })

  test('creates immutable mode-0600 bytes and rejects collisions', async () => {
    const bytes = new TextEncoder().encode('hello')
    const path = await writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, bytes)
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    await expect(writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, bytes)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  test('refuses a symlinked attachment storage root', async () => {
    const outside = join(home, 'outside-root')
    await mkdir(outside)
    await symlink(outside, join(home, 'agent-file-attachments'))
    const error = await captureRejection(writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, new Uint8Array([1])))
    expect(error.message).not.toBe('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await readFile(join(outside, AGENT_ID, ATTACHMENT_ID)).catch(() => null)).toBeNull()
  })

  test('refuses a symlinked agent directory', async () => {
    const outside = join(home, 'outside')
    const agentDir = dirname(agentAttachmentBlobPath(AGENT_ID, ATTACHMENT_ID))
    await mkdir(outside)
    await mkdir(dirname(agentDir), { recursive: true })
    await symlink(outside, agentDir)

    const error = await captureRejection(writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, new Uint8Array([1])))
    expect(error.message).not.toBe('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await readFile(join(outside, ATTACHMENT_ID)).catch(() => null)).toBeNull()
  })

  test('does not follow a replaced agent directory while deleting', async () => {
    const path = await writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, new Uint8Array([1]))
    const agentDirectory = dirname(path)
    const outside = join(home, 'delete-outside')
    await mkdir(outside)
    await writeFile(join(outside, ATTACHMENT_ID), 'keep')
    await rm(agentDirectory, { recursive: true })
    await symlink(outside, agentDirectory)
    await expect(deleteAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID)).rejects.toThrow()
    expect(await readFile(join(outside, ATTACHMENT_ID), 'utf8')).toBe('keep')
  })

  test('rejects final symlinks without changing their target and deletes the link safely', async () => {
    const outside = join(home, 'outside-final')
    const finalPath = agentAttachmentBlobPath(AGENT_ID, ATTACHMENT_ID)
    await mkdir(dirname(finalPath), { recursive: true })
    await writeFile(outside, 'keep')
    await symlink(outside, finalPath)

    await expect(
      writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, new TextEncoder().encode('evil'))
    ).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(await readFile(outside, 'utf8')).toBe('keep')
    await deleteAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID)
    expect(await lstat(finalPath).catch(() => null)).toBeNull()
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  test('fails closed across agent-directory and staging replacement races', async () => {
    const finalPath = agentAttachmentBlobPath(AGENT_ID, ATTACHMENT_ID)
    const agentDirectory = dirname(finalPath)
    const outside = join(home, 'race-outside')
    await mkdir(outside)
    await writeFile(join(outside, ATTACHMENT_ID), 'keep')

    await expect(
      writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, new TextEncoder().encode('safe'), {
        afterAgentDirectoryOpened: async () => {
          await rename(agentDirectory, join(home, 'held-agent'))
          await symlink(outside, agentDirectory)
        },
      })
    ).rejects.toThrow('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await readFile(join(outside, ATTACHMENT_ID), 'utf8')).toBe('keep')

    await rm(join(home, 'agent-file-attachments'), { recursive: true, force: true })
    await expect(
      writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, new TextEncoder().encode('safe'), {
        afterPrePublishValidation: async (stagingBasename) => {
          await rm(join(home, stagingBasename))
          await writeFile(join(home, stagingBasename), 'evil')
        },
      })
    ).rejects.toThrow('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await lstat(finalPath).catch(() => null)).toBeNull()

    await rm(join(home, 'agent-file-attachments'), { recursive: true, force: true })
    const outsideTarget = join(outside, 'target')
    await writeFile(outsideTarget, 'authored')
    await expect(
      writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, new TextEncoder().encode('safe'), {
        afterPrePublishValidation: async (stagingBasename) => {
          await rm(join(home, stagingBasename))
          await symlink(outsideTarget, join(home, stagingBasename))
        },
      })
    ).rejects.toThrow()
    expect(await lstat(finalPath).catch(() => null)).toBeNull()
    expect(await readFile(outsideTarget, 'utf8')).toBe('authored')
  })

  test('verifies length and digest before returning bytes', async () => {
    const bytes = new TextEncoder().encode('hello')
    const path = await writeAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, bytes)
    const digest = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    expect(await readVerifiedAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, 5, digest)).toEqual(Buffer.from(bytes))
    await writeFile(path, 'changed')
    await expect(readVerifiedAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID, 5, digest)).rejects.toThrow(
      'ATTACHMENT_BLOB_CORRUPT'
    )
    await deleteAgentAttachmentBlob(AGENT_ID, ATTACHMENT_ID)
  })
})
