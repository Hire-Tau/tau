import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { agentFileAttachments, messageAgentFileAttachments } from './schema'

function foreignKeyPairs(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference()
    return {
      columns: reference.columns.map((column) => column.name),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      foreignTable: (reference.foreignTable as unknown as Record<symbol, string>)[Symbol.for('drizzle:Name')],
    }
  })
}

describe('agent file attachment schema', () => {
  test('stores immutable agent and sandbox-bound metadata', () => {
    const config = getTableConfig(agentFileAttachments)
    expect(config.name).toBe('agent_file_attachments')
    expect(config.columns.map((column) => column.name)).toEqual([
      'id',
      'agent_id',
      'sandbox_id',
      'uploaded_by_type',
      'uploaded_by_id',
      'original_name',
      'stored_name',
      'private_path',
      'content_type',
      'byte_size',
      'sha256',
      'status',
      'upload_attempt_id',
      'used_at',
      'created_at',
    ])
    expect(config.indexes.map((index) => index.config.name)).toContain('idx_agent_file_attachments_agent')
    expect(foreignKeyPairs(agentFileAttachments)).toContainEqual({
      columns: ['agent_id'],
      foreignColumns: ['id'],
      foreignTable: 'agents',
    })
  })

  test('associates messages and attachments with a composite primary key', () => {
    const config = getTableConfig(messageAgentFileAttachments)
    expect(config.name).toBe('message_agent_file_attachments')
    expect(config.primaryKeys[0].columns.map((column) => column.name)).toEqual(['message_id', 'attachment_id'])
    expect(foreignKeyPairs(messageAgentFileAttachments)).toEqual(
      expect.arrayContaining([
        { columns: ['message_id'], foreignColumns: ['id'], foreignTable: 'messages' },
        {
          columns: ['attachment_id'],
          foreignColumns: ['id'],
          foreignTable: 'agent_file_attachments',
        },
      ])
    )
  })
})
