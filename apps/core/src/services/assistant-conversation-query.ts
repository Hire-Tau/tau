import { sql } from 'drizzle-orm'
import { assistantConversations, assistantEntries, assistantTasks, messages } from '../db'

/** Shared list/search visibility: editor sessions and unused bindings are not recent chats. */
export function listedAssistantConversation() {
  return sql`${assistantConversations.kind} = 'assistant' AND (
    EXISTS (SELECT 1 FROM ${assistantEntries} WHERE ${assistantEntries.conversationId} = ${assistantConversations.id})
    OR EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.agentId} = ${assistantConversations.agentId})
    OR EXISTS (SELECT 1 FROM ${assistantTasks} WHERE ${assistantTasks.conversationId} = ${assistantConversations.id})
  )`
}
