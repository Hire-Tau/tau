import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { db, inbox } from '../db'
import { InboxMessage } from './InboxMessage'
import { InboxAttachment } from './InboxAttachment'
import { getSettingsStore } from '../services/settings'

let home: string
const orig = process.env.HOME_DIR
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'inbox-msg-att-'))
  process.env.HOME_DIR = home
  await getSettingsStore().initialize()
})
afterEach(async () => {
  if (orig === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = orig
  await rm(home, { recursive: true, force: true })
})

describe('InboxMessage attachments', () => {
  test('toJson emits [] by default and the loaded attachments after attachTo', async () => {
    const [row] = await db
      .insert(inbox)
      .values({ recipientType: 'user', recipientId: 'user', senderType: 'system', content: 'hi' })
      .returning()
    const msg = await InboxMessage.find(row.id)
    expect(msg!.toJson().attachments).toEqual([])

    await InboxAttachment.create({
      messageId: row.id,
      filename: 'a.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('x'),
    })
    await InboxAttachment.attachTo([msg!])
    expect(msg!.toJson().attachments?.map((a) => a.filename)).toEqual(['a.txt'])
  })
})
