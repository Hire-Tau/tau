import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

let home: string
const orig = process.env.HOME_DIR
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'inbox-att-'))
  process.env.HOME_DIR = home
})
afterEach(async () => {
  if (orig === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = orig
  await rm(home, { recursive: true, force: true })
})

async function mod() {
  return import('./attachment-storage')
}

describe('attachment-storage', () => {
  test('writes bytes to the dedicated path and reads them back', async () => {
    const { writeAttachmentFile, readAttachmentFile, inboxAttachmentPath } = await mod()
    const bytes = new TextEncoder().encode('hello')
    const path = await writeAttachmentFile('msg1', 'att1', bytes)
    expect(path).toBe(inboxAttachmentPath('msg1', 'att1'))
    expect(path).toContain(join('inbox-attachments', 'msg1', 'att1'))
    expect(await readFile(path, 'utf8')).toBe('hello')
    expect((await readAttachmentFile(path)).toString('utf8')).toBe('hello')
  })

  test('sha256Hex is stable and 64 hex chars', async () => {
    const { sha256Hex } = await mod()
    const hex = sha256Hex(new TextEncoder().encode('hello'))
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  test('deleteAttachmentFile removes the file', async () => {
    const { writeAttachmentFile, deleteAttachmentFile } = await mod()
    const path = await writeAttachmentFile('msg2', 'att2', new Uint8Array([1, 2, 3]))
    await deleteAttachmentFile(path)
    await expect(readFile(path)).rejects.toThrow()
  })
})
