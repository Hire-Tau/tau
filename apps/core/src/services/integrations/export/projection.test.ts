import { expect, test } from 'bun:test'
import { projectCompletedExecution, type ProjectableMessage } from './projection'

const base = { agentId: 'agent', pending: false, createdAt: new Date(0) }
const messages: ProjectableMessage[] = [
  {
    ...base,
    id: 'u',
    role: 'human',
    content: 'hello token=secret-value',
    enqueueOrder: 2n,
    metadata: { source: 'user_chat', executionId: 'execution', sender: { userId: 'user' } },
  },
  {
    ...base,
    id: 'a',
    role: 'assistant',
    content: 'hello',
    enqueueOrder: 3n,
    metadata: {
      executionId: 'execution',
      streamGroupId: 'execution:run-id:1',
      content: [{ type: 'toolCall', arguments: { secret: true } }],
    },
  },
]
const context = {
  agentId: 'agent',
  executionId: 'execution',
  consentingUserId: 'user',
  adoptedEnqueueOrder: 1n,
  policyVersion: 1,
  projectionVersion: 1,
}

test('projects only text and safe server-owned provenance', () => {
  const result = projectCompletedExecution(messages, context)
  expect(result.included).toBe(true)
  expect(result.included && JSON.stringify(result.records)).not.toContain('toolCall')
  expect(result.included && JSON.stringify(result.records)).not.toContain('secret-value')
})

test.each([
  ['before high water', { enqueueOrder: 1n }],
  ['other agent', { agentId: 'other' }],
  ['pending', { pending: true }],
  ['attachment', { metadata: { ...(messages[0]!.metadata as object), attachments: ['file'] } }],
  ['untrusted source', { metadata: { ...(messages[0]!.metadata as object), source: 'inbox' } }],
])('excludes the whole execution for %s', (_name, change) => {
  const mutated = [{ ...messages[0]!, ...change }, messages[1]!]
  expect(projectCompletedExecution(mutated, context)).toMatchObject({ included: false })
})
