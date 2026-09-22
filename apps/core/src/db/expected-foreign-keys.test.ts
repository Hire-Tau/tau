import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { db } from './index'
import { chatSendReceipts } from './schema'
import { expectedForeignKeys, foreignKeyStatements } from './expected-foreign-keys'

test('derives every declared foreign key including durable receipts and delete/update semantics', () => {
  const expected = expectedForeignKeys()
  expect(expected.size).toBeGreaterThan(100)
  expect(expected.get('chat_send_receipts|chat_send_receipts_message_id_messages_id_fk')).toMatchObject({
    table: 'chat_send_receipts',
    name: 'chat_send_receipts_message_id_messages_id_fk',
    deleteAction: 'r',
    updateAction: 'a',
    definition:
      'FOREIGN KEY ("message_id") REFERENCES "public"."messages" ("id") ON DELETE restrict ON UPDATE no action',
  })
  expect(expected.get('role_assignments|role_assignments_squad_id_squads_id_fk')?.deleteAction).toBe('c')
})

test('repairs a missing receipt foreign key in an existing test schema without dropping its table', async () => {
  const rollback = new Error('rollback test DDL')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw('ALTER TABLE chat_send_receipts DROP CONSTRAINT IF EXISTS chat_send_receipts_message_id_messages_id_fk')
      )
      const [missing] = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'chat_send_receipts'::regclass AND conname = 'chat_send_receipts_message_id_messages_id_fk'`
      )
      expect(missing!.n).toBe(0)
      for (const statement of foreignKeyStatements({ chatSendReceipts })) await tx.execute(sql.raw(statement))
      const [restored] = await tx.execute<{ action: string; valid: boolean }>(
        sql`SELECT confdeltype AS action, convalidated AS valid FROM pg_constraint WHERE conrelid = 'chat_send_receipts'::regclass AND conname = 'chat_send_receipts_message_id_messages_id_fk'`
      )
      expect(restored).toEqual({ action: 'r', valid: true })
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
