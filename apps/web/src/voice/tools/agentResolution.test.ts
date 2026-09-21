import { expect, mock, test } from 'bun:test'
import { agentHandle, resolveAgentByReference } from './agentResolution'

const xenon = { id: 'df4ab896-96d5-4d74-9858-40e8a330037e', agentTypeId: 'manager', status: 'idle' }
const tern = { id: 'fd39cd21-61d3-4c4b-b8f1-3bca5fed4ae4', agentTypeId: 'manager', status: 'idle' }
const retired = { id: 'df4ab896-0000-4000-8000-000000000000', agentTypeId: 'engineer', status: 'terminated' }

function deps(agents = [xenon, tern, retired]) {
  const getAgent = mock(async (id: string) => {
    const found = agents.find((agent) => agent.id === id)
    if (!found) throw new Error('API error: 404: Agent not found')
    return found as any
  })
  const listAgents = mock(async () => agents as any)
  return { getAgent, listAgents }
}

test('agentHandle is the first segment of an id or handle, or nothing for other strings', () => {
  expect(agentHandle('df4ab896-96d5-4d74-9858-40e8a330037e')).toBe('df4ab896')
  expect(agentHandle('DF4AB896')).toBe('df4ab896')
  expect(agentHandle(' df4ab896 ')).toBe('df4ab896')
  expect(agentHandle('manager')).toBeUndefined()
  expect(agentHandle('df4a')).toBeUndefined()
})

test('a full id resolves directly without listing', async () => {
  const d = deps()
  expect((await resolveAgentByReference(xenon.id, d)).id).toBe(xenon.id)
  expect(d.listAgents).not.toHaveBeenCalled()
})

test('a spliced id or bare handle resolves to the unique live agent with that first segment', async () => {
  const d = deps()
  expect((await resolveAgentByReference('df4ab896-61d3-4c4b-b8f1-3bca5fed4ae4', d)).id).toBe(xenon.id)
  expect((await resolveAgentByReference('df4ab896', d)).id).toBe(xenon.id)
  expect(d.getAgent).toHaveBeenCalledTimes(1)
})

test('an ambiguous or unknown handle fails without guessing', async () => {
  const twin = { ...tern, id: 'df4ab896-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  await expect(resolveAgentByReference('df4ab896', deps([xenon, twin]))).rejects.toThrow('ambiguous')
  await expect(resolveAgentByReference('00000000', deps())).rejects.toThrow('Unknown agent')
  // A non-hex reference is looked up exactly and its own not-found error surfaces; no handle fallback.
  const d = deps()
  await expect(resolveAgentByReference('morgan', d)).rejects.toThrow('404')
  expect(d.listAgents).not.toHaveBeenCalled()
})

test('non-404 lookup failures surface instead of falling back to a listing', async () => {
  const d = deps()
  d.getAgent.mockImplementation(async () => {
    throw new Error('API error: 500: boom')
  })
  await expect(resolveAgentByReference(xenon.id, d)).rejects.toThrow('500')
  expect(d.listAgents).not.toHaveBeenCalled()
})
