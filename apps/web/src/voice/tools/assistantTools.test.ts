import { expect, mock, test } from 'bun:test'
import * as squads from '../../api/squads'
import * as workspace from '../../api/workspace'
import { createAssistantTools } from './assistantTools'
const id = '11111111-1111-4111-8111-111111111111'
const squadDeps = {
  ...squads,
  listSquads: async () => [{ id, name: 'Tau', createdAt: '2026-01-01', purpose: 'Development' }] as any,
}
const env = { navigate() {}, can: () => true }
function find(tools: ReturnType<typeof createAssistantTools>, name: string) {
  return tools.find((t) => t.definition.name === name)!
}
test('the manager and user-assistant message tools no longer exist', () => {
  const names = createAssistantTools().map((tool) => tool.definition.name)
  for (const gone of ['message_user_assistant', 'message_squad_manager', 'message_work_stream_manager'])
    expect(names).not.toContain(gone)
  expect(names).toContain('delegate_task')
})
test('memory, files, activity, and subscriptions resolve route slugs before calling permission-checked APIs', async () => {
  const memory = mock(async () => []),
    activity = mock(async () => []),
    subscribe = mock(async () => undefined)
  const file = mock(async () => ({ path: '/context.md', content: 'a'.repeat(13000), binary: false, size: 13000 }))
  const tools = createAssistantTools({
    squads: { ...squadDeps, listSquadActivity: activity as any, subscribeSquad: subscribe as any },
    searchMemory: memory as any,
    workspace: { ...workspace, getSquadMemoryFile: file },
  })
  await find(tools, 'search_memory').execute({ squadId: 'tau', query: 'context' }, env)
  expect(memory.mock.calls).toEqual([[id, { query: 'context', limit: 10 }]])
  await find(tools, 'read_activity').execute({ squadId: 'tau', limit: 3 }, env)
  expect(activity.mock.calls).toEqual([[id, { limit: 3 }]])
  await find(tools, 'set_subscription').execute({ scope: 'squad', id: 'tau', watching: true }, env)
  expect(subscribe.mock.calls).toEqual([[id]])
  const result = (await find(tools, 'read_squad_file').execute(
    { squadId: 'tau', source: 'memory', path: '/context.md' },
    env
  )) as any
  expect(file.mock.calls).toEqual([[id, '/context.md']])
  expect(result.content.length).toBe(12000)
  expect(result.nextOffset).toBe(12000)
})
test('invalid inputs never reach mutations and forbidden responses remain errors', async () => {
  const answer = mock(async () => {
    throw new Error('Forbidden')
  })
  const tools = createAssistantTools({ answerAgentQuestion: answer })
  await expect(find(tools, 'answer_question').execute({ questionId: 'q', answer: '' }, env)).rejects.toThrow()
  expect(answer).not.toHaveBeenCalled()
  await expect(
    find(tools, 'answer_question').execute({ questionId: 'q', answer: 'The user answer' }, env)
  ).rejects.toThrow('Forbidden')
  expect(answer.mock.calls).toEqual([['q', 'The user answer']])
})
test('delegate_task runs instance-wide without a squad and resolves squad slugs for squad tasks', async () => {
  const tools = createAssistantTools({ squads: squadDeps })
  const delegateTask = mock(async () => ({ id: 'message', agentId: 'helper', delivered: true, kind: 'background' }))
  expect(
    await find(tools, 'delegate_task').execute(
      { label: 'Check enabled schedules', request: 'Which schedules are enabled?' },
      { ...env, delegateTask }
    )
  ).toEqual({ id: 'message', agentId: 'helper', delivered: true, kind: 'background' })
  expect(delegateTask.mock.calls).toEqual([
    ['Which schedules are enabled?', { label: 'Check enabled schedules', squadId: undefined, mode: 'steer', inReplyTo: undefined }],
  ])
  await find(tools, 'delegate_task').execute(
    { label: 'Pause deploy stream', request: 'Pause work stream Ship Tau', squadId: 'tau', mode: 'follow-up' },
    { ...env, delegateTask }
  )
  expect(delegateTask.mock.calls[1]).toEqual([
    'Pause work stream Ship Tau',
    { label: 'Pause deploy stream', squadId: id, mode: 'follow-up', inReplyTo: undefined },
  ])
})

test('delegate_task rejects empty labels, unknown squads, and surfaces where delegation is unavailable', async () => {
  const delegateTask = mock(async () => ({}))
  const tools = createAssistantTools({ squads: squadDeps })
  await expect(
    find(tools, 'delegate_task').execute({ label: ' ', request: 'Work' }, { ...env, delegateTask })
  ).rejects.toThrow()
  await expect(
    find(tools, 'delegate_task').execute({ label: 'Task', request: 'Work', squadId: 'nope' }, { ...env, delegateTask })
  ).rejects.toThrow('Unknown or ambiguous squad')
  expect(delegateTask).not.toHaveBeenCalled()
  await expect(find(tools, 'delegate_task').execute({ label: 'Task', request: 'Work' }, env)).rejects.toThrow('unavailable')
})
test('search requests bounded backend results and retains explicit work context', async () => {
  const searchEntities = mock(async () => ({
    results: [
      {
        id,
        kind: 'work_stream' as const,
        label: 'Ship Tau',
        detail: '',
        squadId: id,
        squadName: 'Tau',
        status: 'active',
        updatedAt: '2026-01-01',
        score: 100,
      },
    ],
  }))
  const listAllWorkStreams = mock(async () => [])
  const tools = createAssistantTools({ searchEntities, squads: { ...squadDeps, listAllWorkStreams } })
  const result = (await find(tools, 'search_tau').execute({ query: 'Ship Tau', limit: 3 }, env)) as any
  expect(searchEntities.mock.calls).toEqual([['Ship Tau', 3]])
  expect(listAllWorkStreams).not.toHaveBeenCalled()
  expect(result.results[0]).toMatchObject({
    id,
    workStreamId: id,
    squadId: id,
    squadName: 'Tau',
    path: `/squads/${id}/work?ws=${id}`,
  })
})

const workId = '888b3fdd-6e16-429d-bf12-940268e5f4c8'
const otherSquadId = '22222222-2222-4222-8222-222222222222'
const work = { id: workId, squadId: id, title: 'Ship Tau', status: 'active' }

test('inspect normalizes legacy work IDs and rejects malformed references before the API', async () => {
  const getWorkStream = mock(async () => work as any)
  const tools = createAssistantTools({ squads: { ...squadDeps, getWorkStream } })
  await find(tools, 'inspect_work_stream').execute({ id: `work:${workId}` }, env)
  expect(getWorkStream.mock.calls).toEqual([[workId]])
  await expect(find(tools, 'inspect_work_stream').execute({ id: 'work:unknown' }, env)).rejects.toThrow()
  expect(getWorkStream).toHaveBeenCalledTimes(1)
})

test('conversation suggestions verify access, never send, and only explicit opens change the view', async () => {
  const getAgent = mock(
    async (agentId: string) =>
      ({ id: agentId, squadId: 'squad', agentTypeId: 'manager', metadata: { name: 'Morgan' } }) as any
  )
  const sendAgentMessage = mock(async () => ({ success: true }) as any)
  const openConversation = mock()
  const navigate = mock()
  const tools = createAssistantTools({ getAgent, sendAgentMessage })
  const show = find(tools, 'show_conversation')
  const offered = (await show.execute({ agentId: 'manager' }, { navigate, openConversation })) as any
  expect(offered.opened).toBe(false)
  expect(offered.conversation.agentId).toBe('manager')
  expect(openConversation).not.toHaveBeenCalled()
  expect(navigate).not.toHaveBeenCalled()
  expect(sendAgentMessage).not.toHaveBeenCalled()
  await show.execute({ agentId: 'manager', open: true }, { navigate, openConversation })
  expect(openConversation.mock.calls).toEqual([[offered.conversation]])
  expect(navigate).not.toHaveBeenCalled()
  getAgent.mockImplementation(async () => {
    throw new Error('Forbidden')
  })
  await expect(show.execute({ agentId: 'private', open: true }, { navigate, openConversation })).rejects.toThrow(
    'Forbidden'
  )
  expect(openConversation).toHaveBeenCalledTimes(1)
  expect(sendAgentMessage).not.toHaveBeenCalled()
})
