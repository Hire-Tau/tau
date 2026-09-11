import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { db, inbox } from '../db'
import { InboxAttachment } from './InboxAttachment'
import { getSettingsStore } from '../services/settings'

let home: string
const orig = process.env.HOME_DIR

async function seedMessage(): Promise<string> {
  const [row] = await db
    .insert(inbox)
    .values({ recipientType: 'user', recipientId: 'user', senderType: 'system', content: 'hi' })
    .returning()
  return row.id
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'inbox-att-ent-'))
  process.env.HOME_DIR = home
  const store = getSettingsStore()
  await store.initialize()
  await store.set('INBOX_MAX_ATTACHMENT_BYTES', '10485760')
  await store.set('INBOX_MAX_TOTAL_STORAGE_BYTES', '10737418240')
})
afterEach(async () => {
  if (orig === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = orig
  await rm(home, { recursive: true, force: true })
})

describe('InboxAttachment', () => {
  test('create stores bytes, computes sha256, and lists for the message', async () => {
    const messageId = await seedMessage()
    const att = await InboxAttachment.create({
      messageId,
      filename: 'note.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('hello'),
    })
    expect(att.byteSize).toBe(5)
    expect(att.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    const list = await InboxAttachment.listForMessage(messageId)
    expect(list.map((a) => a.id)).toEqual([att.id])
  })

  test('rejects an attachment over the per-attachment cap', async () => {
    const messageId = await seedMessage()
    await getSettingsStore().set('INBOX_MAX_ATTACHMENT_BYTES', '4')
    await expect(
      InboxAttachment.create({
        messageId,
        filename: 'big.txt',
        contentType: 'text/plain',
        bytes: new TextEncoder().encode('hello'),
      })
    ).rejects.toThrow('ATTACHMENT_TOO_LARGE')
  })

  test('rejects when the global storage quota would be exceeded', async () => {
    const messageId = await seedMessage()
    await getSettingsStore().set('INBOX_MAX_TOTAL_STORAGE_BYTES', '4')
    await expect(
      InboxAttachment.create({
        messageId,
        filename: 'big.txt',
        contentType: 'text/plain',
        bytes: new TextEncoder().encode('hello'),
      })
    ).rejects.toThrow('INBOX_STORAGE_QUOTA_EXCEEDED')
  })

  test('delete removes the row', async () => {
    const messageId = await seedMessage()
    const att = await InboxAttachment.create({
      messageId,
      filename: 'd.txt',
      contentType: 'text/plain',
      bytes: new Uint8Array([1, 2, 3]),
    })
    await att.delete()
    expect(await InboxAttachment.findById(att.id)).toBeNull()
  })
})
