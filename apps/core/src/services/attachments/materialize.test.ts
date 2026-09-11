import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { materializationStagingRoot, materializeAttachmentBytes } from './materialize'

const ID = '6f7e72d8-1aa6-4cec-8d24-80c8ca80ef4d'
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'materialize-'))
})
afterEach(async () => {
  const entries = await readdir(root).catch(() => [])
  expect(entries.filter((name) => name.startsWith('.tau-agent-attachment-'))).toEqual([])
  await rm(root, { recursive: true, force: true })
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

describe('materializeAttachmentBytes', () => {
  test('creates only the generated path with mode 0600', async () => {
    const path = await materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('hello'))
    expect(path).toBe(join(root, 'chat-attachments', ID, 'report.pdf'))
    expect(await readFile(path, 'utf8')).toBe('hello')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const source = await readFile(join(import.meta.dir, 'materialize.ts'), 'utf8')
    expect(source).not.toContain('constants.O_CREAT')
    expect(source).toContain('mkstemp')
    expect(source).toContain('linkat')
    expect(source).not.toContain('tmpdir()')
    expect(materializationStagingRoot('/separate-mounted-private')).toBe('/separate-mounted-private')
    expect(source).toContain('createTemporaryFile(privateRoot)')
    expect(source).toContain('linkTemporaryFile(temporary, root, directory, storedName)')
    expect(source).toContain('assertHeldIdentity(finalFd, temporaryIdentity)')
    expect(source).toContain('published = true')
    expect(source).toContain('closeMaterializationDescriptors([finalFd, temporary.fd], published)')
    expect(source).toContain('if (finalCreated && !published)')
  })

  test('refuses symlinked generated parents without writing outside', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'materialize-outside-'))
    await symlink(outside, join(root, 'chat-attachments'))
    const error = await captureRejection(materializeAttachmentBytes(root, ID, 'report.pdf', new Uint8Array([1])))
    expect(error.message).not.toBe('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await readFile(join(outside, ID, 'report.pdf')).catch(() => null)).toBeNull()
    await rm(outside, { recursive: true, force: true })
  })

  test('refuses a symlinked UUID directory and exclusive collision', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'materialize-outside-'))
    await mkdir(join(root, 'chat-attachments'))
    await symlink(outside, join(root, 'chat-attachments', ID))
    await expect(materializeAttachmentBytes(root, ID, 'report.pdf', new Uint8Array([1]))).rejects.toThrow()
    await rm(join(root, 'chat-attachments'), { recursive: true, force: true })
    await materializeAttachmentBytes(root, ID, 'report.pdf', new Uint8Array([1]))
    await expect(materializeAttachmentBytes(root, ID, 'report.pdf', new Uint8Array([1]))).resolves.toBe(
      join(root, 'chat-attachments', ID, 'report.pdf')
    )
    await expect(materializeAttachmentBytes(root, ID, 'report.pdf', new Uint8Array([2]))).rejects.toThrow(
      'ATTACHMENT_MATERIALIZATION_CONFLICT'
    )
    await rm(outside, { recursive: true, force: true })
  })

  test('refuses a missing private root instead of creating caller-controlled parents', async () => {
    const missing = join(root, 'missing', 'private')
    await expect(materializeAttachmentBytes(missing, ID, 'report.pdf', new Uint8Array([1]))).rejects.toThrow()
    expect(await stat(join(root, 'missing')).catch(() => null)).toBeNull()
  })

  test('rejects invalid and path-shaped attachment UUIDs', async () => {
    for (const id of ['not-a-uuid', '../' + ID, ID + '/child', ID.replace(/^./, 'g')]) {
      await expect(materializeAttachmentBytes(root, id, 'report.pdf', new Uint8Array([1]))).rejects.toThrow(
        'Invalid attachment id'
      )
    }
  })

  test('refuses a symlink at the final filename without changing its target', async () => {
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'generated')
    await mkdir(join(root, 'chat-attachments', ID), { recursive: true })
    await symlink(outside, join(root, 'chat-attachments', ID, 'report.pdf'))

    const error = await captureRejection(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('generated'))
    )
    expect(error.message).not.toBe('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await readFile(outside, 'utf8')).toBe('generated')

    await rm(join(root, 'chat-attachments'), { recursive: true, force: true })
    await mkdir(join(root, 'chat-attachments', ID, 'report.pdf'), { recursive: true })
    await expect(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('generated'))
    ).rejects.toThrow('ATTACHMENT_MATERIALIZATION_CONFLICT')
  })

  test('keeps writing through the held directory when its pathname is swapped', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'materialize-swap-outside-'))
    const attachmentRoot = join(root, 'chat-attachments')
    const idPath = join(attachmentRoot, ID)
    const createdPath = join(attachmentRoot, 'held-before-open-swap')
    await expect(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('safe'), {
        afterAttachmentDirectoryCreated: async () => {
          await rename(idPath, createdPath)
          await mkdir(idPath)
        },
      })
    ).rejects.toThrow('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await readFile(join(createdPath, 'report.pdf')).catch(() => null)).toBeNull()
    expect(await readFile(join(idPath, 'report.pdf')).catch(() => null)).toBeNull()

    await rm(attachmentRoot, { recursive: true, force: true })
    const openedPath = join(attachmentRoot, 'held-after-open-swap')
    await expect(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('safe'), {
        afterAttachmentDirectoryOpened: async () => {
          await rename(idPath, openedPath)
          await symlink(outside, idPath)
        },
      })
    ).rejects.toThrow('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await readFile(join(openedPath, 'report.pdf')).catch(() => null)).toBeNull()
    expect(await readFile(join(outside, 'report.pdf')).catch(() => null)).toBeNull()

    await rm(attachmentRoot, { recursive: true, force: true })
    const precommitPath = join(attachmentRoot, 'held-before-publish-swap')
    await expect(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('safe'), {
        beforePublish: async () => {
          await rename(idPath, precommitPath)
          await symlink(outside, idPath)
        },
      })
    ).rejects.toThrow('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await readFile(join(precommitPath, 'report.pdf')).catch(() => null)).toBeNull()
    expect(await readFile(join(outside, 'report.pdf')).catch(() => null)).toBeNull()

    await rm(attachmentRoot, { recursive: true, force: true })
    const temporaryFilesBefore = (await readdir(root)).filter((name) => name.startsWith('.tau-agent-attachment-'))
    const linkError = await captureRejection(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('safe'), {
        afterPrePublishValidation: async (stagingBasename) => {
          await rm(join(root, stagingBasename))
        },
      })
    )
    expect(linkError.message).toContain('linkat(2) failed')
    expect((await readdir(root)).filter((name) => name.startsWith('.tau-agent-attachment-'))).toEqual(
      temporaryFilesBefore
    )

    await rm(attachmentRoot, { recursive: true, force: true })
    await expect(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('safe'), {
        afterPrePublishValidation: async (stagingBasename) => {
          await rm(join(root, stagingBasename))
          await writeFile(join(root, stagingBasename), 'evil')
        },
      })
    ).rejects.toThrow('ATTACHMENT_MATERIALIZATION_PATH_REPLACED')
    expect(await stat(join(root, 'chat-attachments', ID, 'report.pdf')).catch(() => null)).toBeNull()
    expect((await readdir(root)).filter((name) => name.startsWith('.tau-agent-attachment-'))).toEqual(
      temporaryFilesBefore
    )

    await rm(attachmentRoot, { recursive: true, force: true })
    const outsideTarget = join(outside, 'authored.txt')
    await writeFile(outsideTarget, 'authored')
    await expect(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('safe'), {
        afterPrePublishValidation: async (stagingBasename) => {
          await rm(join(root, stagingBasename))
          await symlink(outsideTarget, join(root, stagingBasename))
        },
      })
    ).rejects.toThrow()
    expect(await stat(join(root, 'chat-attachments', ID, 'report.pdf')).catch(() => null)).toBeNull()
    expect(await readFile(outsideTarget, 'utf8')).toBe('authored')
    expect((await readdir(root)).filter((name) => name.startsWith('.tau-agent-attachment-'))).toEqual(
      temporaryFilesBefore
    )

    await rm(attachmentRoot, { recursive: true, force: true })
    const publishedPath = join(attachmentRoot, 'held-after-publish-swap')
    await expect(
      materializeAttachmentBytes(root, ID, 'report.pdf', new TextEncoder().encode('committed'), {
        afterPublish: async () => {
          await rename(idPath, publishedPath)
          await symlink(outside, idPath)
        },
      })
    ).resolves.toBe(join(root, 'chat-attachments', ID, 'report.pdf'))
    expect(await readFile(join(publishedPath, 'report.pdf'), 'utf8')).toBe('committed')
    expect(await readFile(join(outside, 'report.pdf')).catch(() => null)).toBeNull()
    await rm(outside, { recursive: true, force: true })
  })
})
