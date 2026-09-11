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
test('delegation returns the actual server result; unavailable delegation is explicit', async () => {
  const tools = createAssistantTools()
  const messageUserAssistant = mock(async (_request: string) => ({
    id: 'message',
    agentId: 'assistant',
    delivered: true,
  }))
  expect(
    await find(tools, 'message_user_assistant').execute(
      { request: 'Investigate the stalled job' },
      { ...env, messageUserAssistant }
    )
  ).toEqual({ id: 'message', agentId: 'assistant', delivered: true })
  await expect(find(tools, 'message_user_assistant').execute({ request: 'Work' }, env)).rejects.toThrow('unavailable')
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

test('work-stream coordination selects only the manager of the verified squad', async () => {
  const manager = { id: 'right-manager', squadId: id, agentTypeId: 'manager', status: 'idle' }
  const listSquadAgents = mock(async () => [{ ...manager, id: 'wrong-manager', squadId: otherSquadId }, manager] as any)
  const sendAgentMessage = mock(async () => ({ success: true, status: 'active' }) as any)
  const tools = createAssistantTools({
    squads: { ...squadDeps, getWorkStream: async () => work as any, listSquadAgents },
    getAgent: async () => manager as any,
    sendAgentMessage,
  })
  const result = (await find(tools, 'message_work_stream_manager').execute(
    { workStreamId: `work:${workId}`, content: 'Please pause this work.' },
    env
  )) as any
  expect(listSquadAgents.mock.calls).toEqual([[id]])
  expect(sendAgentMessage.mock.calls).toEqual([
    ['right-manager', `Work stream: Ship Tau (${workId})\n\nPlease pause this work.`, undefined, 'steer'],
  ])
  expect(result.squadId).toBe(id)
})

test('work-stream routing fails without sending on lookup errors, ambiguity, or a changed squad', async () => {
  const manager = { id: 'manager', squadId: id, agentTypeId: 'manager', status: 'idle' }
  for (const scenario of ['lookup-error', 'missing', 'ambiguous', 'changed-squad', 'dormant']) {
    const sendAgentMessage = mock(async () => ({ success: true }) as any)
    const tools = createAssistantTools({
      squads: {
        ...squadDeps,
        getWorkStream: async () => {
          if (scenario === 'lookup-error') throw new Error('API error')
          return work as any
        },
        listSquadAgents: async () =>
          (scenario === 'missing'
            ? []
            : scenario === 'ambiguous'
              ? [manager, { ...manager, id: 'another' }]
              : [manager]) as any,
      },
      getAgent: async () =>
        ({
          ...manager,
          ...(scenario === 'changed-squad' ? { squadId: otherSquadId } : {}),
          ...(scenario === 'dormant' ? { status: 'dormant' } : {}),
        }) as any,
      sendAgentMessage,
    })
    await expect(
      find(tools, 'message_work_stream_manager').execute({ workStreamId: workId, content: 'Pause' }, env)
    ).rejects.toThrow()
    expect(sendAgentMessage).not.toHaveBeenCalled()
  }
})

test('a new DAO DAO incident routes directly to its verified manager without any work-stream search', async () => {
  const manager = { id: 'dao-manager', squadId: id, agentTypeId: 'manager', status: 'idle' }
  const getWorkStream = mock(async () => {
    throw new Error('A new report has no work stream')
  })
  const searchEntities = mock(async () => [] as any)
  const sendAgentMessage = mock(async () => ({ success: true, status: 'active' }) as any)
  const messageAgent = mock(async () => ({ id: 'receipt', delivered: true }))
  const listSquads = mock(
    async () => [{ id, name: 'DAO DAO', purpose: 'Manage the DAO DAO platform', status: 'active' }] as any
  )
  const tools = createAssistantTools({
    squads: { ...squadDeps, listSquads, getWorkStream, listSquadAgents: async () => [manager] as any },
    getAgent: async () => manager as any,
    searchEntities,
    sendAgentMessage,
  })
  const content =
    'The DAO DAO frontend is getting a 500 error on THORChain DAOs: https://daodao.zone/dao/thor1l2fyshlx6kngng08hs88jdgs3tvu0e3ny5aemfp3tuuu0ma2gklqkqydna'
  const result = await find(tools, 'message_squad_manager').execute({ squadId: id, content }, { ...env, messageAgent })
  expect(result).toEqual({ receipt: { id: 'receipt', delivered: true }, squadId: id, managerId: manager.id })
  expect(messageAgent.mock.calls).toEqual([[manager.id, content, 'follow-up']])
  expect(listSquads.mock.calls).toEqual([['active']])
  expect(searchEntities).not.toHaveBeenCalled()
  expect(getWorkStream).not.toHaveBeenCalled()
  expect(sendAgentMessage).not.toHaveBeenCalled()
  await find(tools, 'message_squad_manager').execute({ squadId: 'dao-dao', content }, env)
  expect(sendAgentMessage.mock.calls).toEqual([[manager.id, content, undefined, 'follow-up']])
})

test('new-report routing never substitutes a manager after an unknown squad, ambiguous manager, or changed assignment', async () => {
  const manager = { id: 'dao-manager', squadId: id, agentTypeId: 'manager', status: 'idle' }
  for (const scenario of ['unknown-squad', 'missing-manager', 'ambiguous-manager', 'changed-squad', 'terminated']) {
    const sendAgentMessage = mock(async () => ({ success: true }) as any)
    const messageAgent = mock(async () => ({}))
    const tools = createAssistantTools({
      squads: {
        ...squadDeps,
        listSquads: async () => (scenario === 'unknown-squad' ? [] : ([{ id, name: 'DAO DAO' }] as any)),
        listSquadAgents: async () =>
          (scenario === 'missing-manager'
            ? []
            : scenario === 'ambiguous-manager'
              ? [manager, { ...manager, id: 'another' }]
              : [manager]) as any,
      },
      getAgent: async () =>
        ({
          ...manager,
          ...(scenario === 'changed-squad' ? { squadId: otherSquadId } : {}),
          ...(scenario === 'terminated' ? { status: 'terminated' } : {}),
        }) as any,
      sendAgentMessage,
    })
    await expect(
      find(tools, 'message_squad_manager').execute(
        { squadId: id, content: 'Report the outage' },
        { ...env, messageAgent }
      )
    ).rejects.toThrow()
    expect(sendAgentMessage).not.toHaveBeenCalled()
    expect(messageAgent).not.toHaveBeenCalled()
  }
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
