import type { Message } from './types'

export type MessageTimeInput = Pick<Message, 'role' | 'metadata'> & { createdAt: Date | string }

/** Effective persisted chronology at JavaScript Date millisecond precision. */
export function messageSortAt(message: MessageTimeInput): number {
  if (message.role === 'human' && message.metadata?.consumedAt) {
    return new Date(message.metadata.consumedAt).getTime()
  }
  return message.createdAt instanceof Date ? message.createdAt.getTime() : new Date(message.createdAt).getTime()
}
