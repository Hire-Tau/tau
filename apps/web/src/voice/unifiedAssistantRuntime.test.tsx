import { expect, mock, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { RealtimeTransport, type TransportCallbacks, type RealtimeSessionConfig } from './realtimeTransport'
import { useRealtimeVoiceAssistant, type UseRealtimeVoiceAssistantReturn } from './useRealtimeVoiceAssistant'
import { restoreVoiceConversation } from './voiceConversationRecovery'

const config: RealtimeSessionConfig = {
  model: 'test',
  instructions: 'Static instructions',
  tools: [],
  output_modalities: ['audio'],
  tool_choice: 'auto',
  audio: { input: { turn_detection: null } },
}
test('typed turns connect once without a mic; toggling voice preserves the connection and saved history', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  let latest!: UseRealtimeVoiceAssistantReturn<null>
  const sent: any[] = [],
    configs: RealtimeSessionConfig[] = [],
    options: any[] = []
  let callbacks!: TransportCallbacks,
    connects = 0,
    enabled = 0,
    disabled = 0
  class Transport extends RealtimeTransport {
    connected = false
    override get isConnected() {
      return this.connected
    }
    override async connect(c: RealtimeSessionConfig, cb: TransportCallbacks, _signal?: AbortSignal, opts?: any) {
      connects++
      configs.push(c)
      options.push(opts)
      callbacks = cb
      this.connected = true
    }
    override disconnect() {
      this.connected = false
    }
    override sendEvent(event: any) {
      sent.push(event)
    }
    override setMicEnabled() {}
    override async enableAudioInput() {
      enabled++
    }
    override async disableAudioInput() {
      disabled++
    }
    override updateSession(c: any) {
      sent.push({ type: 'session.update', session: c })
    }
  }
  const transport = new Transport()
  let controllerRuntime: { requestResponse: () => void } | undefined
  const controller = {
    onConnected: (runtime: { requestResponse: () => void }) => {
      controllerRuntime = runtime
    },
    id: 'unified-test',
    initialState: null,
    useEnvironment: () => null,
    prepareSession: async () => ({
      sessionConfig: config,
      history: [{ id: 'prior', role: 'user' as const, text: 'Earlier question', final: true }],
    }),
    executeTool: async () => ({ result: null, followUp: false as const }),
  }
  function Probe() {
    latest = useRealtimeVoiceAssistant(controller, {
      textOnly: true,
      autoReconnect: false,
      createTransport: () => transport,
    })
    return <span>{latest.status}</span>
  }
  try {
    const { root } = dom.createRoot()
    await dom.act(async () => root.render(<Probe />))
    await dom.act(async () => latest.sendText('New question'))
    expect(connects).toBe(1)
    expect(enabled).toBe(0)
    expect(options[0].textOnly).toBe(true)
    expect(configs[0].output_modalities).toEqual(['text'])
    expect(latest.history.map((e) => e.text)).toEqual(['Earlier question', 'New question'])
    await dom.act(async () => latest.setLiveAudio(true))
    expect(connects).toBe(1)
    expect(enabled).toBe(1)
    expect(latest.isLiveAudio).toBe(true)
    await dom.act(async () =>
      callbacks.onServerEvent({ type: 'response.done', response: { status: 'completed', output: [] } })
    )
    await dom.act(async () => latest.sendText('A silent follow-up'))
    expect(sent.filter((event) => event.type === 'response.create').at(-1).response.output_modalities).toEqual(['text'])
    await dom.act(async () =>
      callbacks.onServerEvent({ type: 'response.done', response: { status: 'completed', output: [] } })
    )
    await dom.act(async () => {
      callbacks.onServerEvent({ type: 'input_audio_buffer.speech_started' } as any)
      callbacks.onServerEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Spoken question',
      } as any)
    })
    const beforeUpdate = sent.length
    await dom.act(async () =>
      latest.enqueueMessage({
        id: 'agent-update',
        text: 'The requested research is ready',
        disableMic: false,
        historyEntry: { id: 'agent-update', role: 'tool', text: 'Research result', final: true },
      })
    )
    // An inbox update must wait for the spoken turn, rather than interrupting the user.
    expect(sent).toHaveLength(beforeUpdate)
    await dom.act(async () => controllerRuntime!.requestResponse())
    expect(sent.filter((event) => event.type === 'response.create').at(-1).response.output_modalities).toEqual([
      'audio',
    ])
    await dom.act(async () => latest.setLiveAudio(false))
    expect(disabled).toBe(1)
    expect(latest.isLiveAudio).toBe(false)
    expect(latest.history.map((e) => e.text)).toEqual([
      'Earlier question',
      'New question',
      'A silent follow-up',
      'Spoken question',
    ])
    expect(sent.filter((e) => e.type === 'session.update').map((e) => e.session.output_modalities)).toEqual([
      ['audio'],
      ['text'],
    ])
    await dom.act(async () => callbacks.onServerEvent({ type: 'response.created', response: {} } as any))
    await dom.act(async () =>
      callbacks.onServerEvent({ type: 'response.done', response: { status: 'completed', output: [] } })
    )
    expect(latest.history.at(-1)?.id).toBe('agent-update')
    expect(sent.filter((e) => e.type === 'conversation.item.create').at(-1).item.content[0].text).toBe(
      'The requested research is ready'
    )
  } finally {
    await dom.cleanup()
  }
})

for (const fails of [false, true])
  test(`starting live voice negotiates audio before ICE${fails ? ' and cleans up a failed connection' : ''}`, async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    let latest!: UseRealtimeVoiceAssistantReturn<null>
    const connections: any[] = []
    const cleanup = mock()
    class Transport extends RealtimeTransport {
      connected = false
      override get isConnected() {
        return this.connected
      }
      override async connect(c: RealtimeSessionConfig, _cb: TransportCallbacks, _signal?: AbortSignal, opts?: any) {
        connections.push({ config: c, options: opts })
        if (fails) throw new Error('Peer connection failed')
        this.connected = true
      }
      override disconnect() {
        this.connected = false
        cleanup()
      }
      override async enableAudioInput() {}
      override setMicEnabled() {}
      override updateSession() {}
    }
    const transport = new Transport()
    const controller = {
      id: 'live-start',
      initialState: null,
      useEnvironment: () => null,
      prepareSession: async () => ({ sessionConfig: config }),
      executeTool: async () => ({ result: null, followUp: false as const }),
    }
    function Probe() {
      latest = useRealtimeVoiceAssistant(controller, {
        textOnly: true,
        autoReconnect: false,
        createTransport: () => transport,
      })
      return null
    }
    try {
      const { root } = dom.createRoot()
      await dom.act(async () => root.render(<Probe />))
      await dom.act(async () => {
        if (fails) await expect(latest.setLiveAudio(true)).rejects.toThrow('Realtime could not connect')
        else await latest.setLiveAudio(true)
      })
      expect(connections[0].options).toEqual({ initialMicEnabled: true, textOnly: false })
      expect(connections[0].config.output_modalities).toEqual(['audio'])
      expect(latest.isLiveAudio).toBe(!fails)
      if (fails) expect(cleanup).toHaveBeenCalledTimes(1)
    } finally {
      await dom.cleanup()
    }
  })

test('ending voice during pending microphone permission stops the late stream and never attaches it', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  let release!: (stream: MediaStream) => void
  const stop = mock(),
    replaceTrack = mock(async () => {})
  const track = { stop, enabled: true }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          release = resolve
        }),
    },
  })
  const transport = new RealtimeTransport()
  const internal = transport as any
  internal.peerConnection = {}
  internal.audioSender = { replaceTrack }
  try {
    const pending = transport.enableAudioInput(true)
    const rejected = pending.catch((error) => error)
    await transport.disableAudioInput()
    release(stream)
    expect((await rejected).name).toBe('AbortError')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(replaceTrack.mock.calls).toEqual([[null]])
    expect(internal.localTrack).toBeNull()
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'mediaDevices', descriptor)
    else Reflect.deleteProperty(navigator, 'mediaDevices')
    await dom.cleanup()
  }
})

test('saved tool outputs restore as context without reissuing tool calls or triggering a response', () => {
  const sendEvent = mock()
  restoreVoiceConversation({ sendEvent }, [
    {
      id: 'tool',
      role: 'tool',
      text: 'Check status',
      toolName: 'get_status',
      toolResult: '{"status":"idle"}',
      final: true,
    },
  ])
  expect(sendEvent).toHaveBeenCalledTimes(1)
  const event = sendEvent.mock.calls[0][0]
  expect(event.type).toBe('conversation.item.create')
  expect(event.item.type).toBe('message')
  expect(event.item.content[0].text).toContain('context only, do not rerun')
  expect(event.item.content[0].text).toContain('idle')
})

async function recoveryFixture() {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  let latest!: UseRealtimeVoiceAssistantReturn<null>
  let fail = false
  let now = 0
  let setupWait: Promise<void> | undefined
  let timer: (() => void) | undefined
  const instances: Transport[] = []
  class Transport extends RealtimeTransport {
    connected = false
    callbacks!: TransportCallbacks
    events: any[] = []
    override get isConnected() {
      return this.connected
    }
    override async connect(_config: RealtimeSessionConfig, callbacks: TransportCallbacks) {
      this.callbacks = callbacks
      await setupWait
      if (fail) throw new Error('Peer connection failed')
      this.connected = true
    }
    override disconnect() {
      this.connected = false
    }
    override sendEvent(event: any) {
      this.events.push(event)
    }
    override setMicEnabled() {}
    override updateSession() {}
    override async enableAudioInput() {}
    emit(event: any) {
      this.callbacks.onServerEvent(event)
    }
    drop() {
      this.connected = false
      this.callbacks.onError(new Error('Peer connection disabled'))
    }
  }
  const tool = mock(async (): Promise<{ result: unknown; followUp: 'auto' }> => ({ result: 'done', followUp: 'auto' }))
  const controller = {
    id: 'recovery',
    initialState: null,
    useEnvironment: () => null,
    prepareSession: async () => ({ sessionConfig: config }),
    executeTool: tool,
  }
  const reconnectClock = {
    now: () => now,
    setTimeout: (callback: () => void) => {
      timer = callback
      return 1
    },
    clearTimeout: () => {
      timer = undefined
    },
  } as any
  function Probe() {
    latest = useRealtimeVoiceAssistant(controller, {
      textOnly: true,
      autoReconnect: true,
      maxReconnectAttempts: 2,
      reconnectClock,
      createTransport: () => {
        const transport = new Transport()
        instances.push(transport)
        return transport
      },
    })
    return null
  }
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<Probe />))
  return {
    dom,
    instances,
    tool,
    get latest() {
      return latest
    },
    setFail: (value: boolean) => {
      fail = value
    },
    waitSetup: (value?: Promise<void>) => {
      setupWait = value
    },
    advanceTime: (ms: number) => {
      now += ms
    },
    hasRetry: () => Boolean(timer),
    expireRetry: async () => {
      await dom.act(async () => {
        const callback = timer
        timer = undefined
        callback?.()
        await Promise.resolve()
      })
    },
  }
}

test('failed setup retains a visible message and auto-reconnect submits it once', async () => {
  const f = await recoveryFixture()
  try {
    f.setFail(true)
    await f.dom.act(async () => f.latest.sendText('Keep my question'))
    expect(f.latest.history.map((entry) => entry.text)).toEqual(['Keep my question'])
    expect(f.latest.history[0]!.id).toHaveLength(32)
    expect(f.latest.pendingTextCount).toBe(1)
    expect(f.latest.isReconnecting).toBe(true)
    f.setFail(false)
    await f.expireRetry()
    const transport = f.instances.at(-1)!
    expect(transport.events.filter((event) => event.type === 'conversation.item.create')).toHaveLength(1)
    expect(transport.events.filter((event) => event.type === 'response.create')).toHaveLength(1)
    expect(f.latest.status).toBe('processing')
    await f.dom.act(async () => transport.emit({ type: 'response.created' }))
    expect(f.latest.pendingTextCount).toBe(0)
    expect(f.latest.history.filter((entry) => entry.role === 'user')).toHaveLength(1)
  } finally {
    await f.dom.cleanup()
  }
})

test('concurrent sends and a manual retry share one pending handshake', async () => {
  const f = await recoveryFixture()
  let finish!: () => void
  f.waitSetup(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  try {
    let first!: Promise<void>, second!: Promise<void>, retry!: Promise<void>
    await f.dom.act(async () => {
      first = f.latest.sendText('First')
      second = f.latest.sendText('Second')
      retry = f.latest.retryConnection()
    })
    expect(f.instances).toHaveLength(1)
    expect(f.latest.history.filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual([
      'First',
      'Second',
    ])
    await f.dom.act(async () => {
      finish()
      await Promise.all([first, second, retry])
    })
    expect(f.instances).toHaveLength(1)
    expect(f.instances[0]!.events.filter((event) => event.type === 'conversation.item.create')).toHaveLength(2)
    expect(f.instances[0]!.events.filter((event) => event.type === 'response.create')).toHaveLength(1)
  } finally {
    finish()
    await f.dom.cleanup()
  }
})

test('disconnect before response acknowledgement retries without duplicating the user item', async () => {
  const f = await recoveryFixture()
  try {
    await f.dom.act(async () => f.latest.sendText('Unanswered'))
    await f.dom.act(async () => f.instances[0]!.drop())
    await f.expireRetry()
    const events = f.instances[1]!.events
    expect(events.filter((event) => event.item?.role === 'user')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'response.create')).toHaveLength(1)
    expect(f.latest.history.filter((entry) => entry.role === 'user')).toHaveLength(1)
  } finally {
    await f.dom.cleanup()
  }
})

test('reconnect resumes an acknowledged request after its existing tool finishes, without rerunning it', async () => {
  const f = await recoveryFixture()
  let finish!: (value: { result: unknown; followUp: 'auto' }) => void
  f.tool.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  try {
    await f.dom.act(async () => f.latest.sendText('Do some work'))
    await f.dom.act(async () => {
      f.instances[0]!.emit({ type: 'response.created' })
      f.instances[0]!.emit({
        type: 'response.done',
        response: {
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'work-1', name: 'delegate_work', arguments: '{}' }],
        },
      })
    })
    expect(f.tool).toHaveBeenCalledTimes(1)
    await f.dom.act(async () => f.instances[0]!.drop())
    await f.expireRetry()
    expect(f.latest.status).toBe('connecting')
    await f.dom.act(async () => {
      finish({ result: 'Work finished', followUp: 'auto' })
      await f.latest.retryConnection()
    })
    expect(f.instances).toHaveLength(2)
    const events = f.instances[1]!.events
    await f.dom.act(async () =>
      f.instances[1]!.emit({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'work-1', name: 'delegate_work', arguments: '{}' },
      })
    )
    expect(JSON.stringify(events)).toContain('Work finished')
    expect(events.filter((event) => event.type === 'response.create')).toHaveLength(1)
    expect(f.tool).toHaveBeenCalledTimes(1)
  } finally {
    finish?.({ result: 'done', followUp: 'auto' })
    await f.dom.cleanup()
  }
})

test('repeated idle connection loss exhausts recovery instead of reconnecting forever', async () => {
  const f = await recoveryFixture()
  try {
    await f.dom.act(async () => f.latest.sendText('Hello'))
    await f.dom.act(async () => {
      f.instances[0]!.emit({ type: 'response.created' })
      f.instances[0]!.emit({ type: 'response.done', response: { status: 'completed', output: [] } })
    })
    for (let i = 0; i < 2; i++) {
      await f.dom.act(async () => f.instances.at(-1)!.drop())
      expect(f.hasRetry()).toBe(true)
      await f.expireRetry()
      expect(f.instances.at(-1)!.events.filter((event) => event.type === 'response.create')).toHaveLength(0)
    }
    await f.dom.act(async () => f.instances.at(-1)!.drop())
    expect(f.hasRetry()).toBe(false)
    expect(f.latest.isReconnecting).toBe(false)
    expect(f.instances).toHaveLength(3)
  } finally {
    await f.dom.cleanup()
  }
})

test('structured tool errors are marked failed while full validation details reach the model', async () => {
  const f = await recoveryFixture()
  const result = { error: 'API error: 400: [{"code":"invalid_literal","path":["schemaVersion"],"expected":1}]' }
  f.tool.mockImplementation(async () => ({ result, followUp: 'auto' }))
  try {
    await f.dom.act(async () => f.latest.sendText('Build a flow'))
    await f.dom.act(async () => {
      f.instances[0]!.emit({ type: 'response.created' })
      f.instances[0]!.emit({
        type: 'response.done',
        response: {
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'edit-1', name: 'edit', arguments: '{"baseRevision":0}' }],
        },
      })
    })
    const entry = f.latest.history.find((entry) => entry.toolCallId === 'edit-1')!
    expect(entry.toolError).toBe(true)
    expect(entry.toolArgs).toContain('baseRevision')
    expect(JSON.parse(entry.toolResult!)).toEqual(result)
  } finally {
    await f.dom.cleanup()
  }
})

test('editor messages carry current draft context without exposing it in the transcript', async () => {
  const f = await recoveryFixture()
  try {
    f.setFail(false)
    await f.dom.act(async () => f.latest.sendText('Review my edits', '[Current draft revision 7: manual changes]'))
    const event = f.instances.at(-1)!.events.find((event) => event.type === 'conversation.item.create') as any
    expect(event.item.content[0].text).toBe('Review my edits\n\n[Current draft revision 7: manual changes]')
    expect(f.latest.history[0]!.text).toBe('Review my edits')
  } finally {
    await f.dom.cleanup()
  }
})

test('successful turns renew recovery for a later outage in the same conversation', async () => {
  const f = await recoveryFixture()
  try {
    await f.dom.act(async () => f.latest.sendText('Hello'))
    for (let i = 0; i < 4; i++) {
      await f.dom.act(async () => {
        f.instances.at(-1)!.emit({ type: 'response.created' })
        f.instances.at(-1)!.emit({ type: 'response.done', response: { status: 'completed', output: [] } })
        f.instances.at(-1)!.drop()
      })
      expect(f.hasRetry()).toBe(true)
      await f.expireRetry()
    }
    expect(f.instances).toHaveLength(5)
  } finally {
    await f.dom.cleanup()
  }
})

test('a stable idle connection renews recovery without generating unsolicited responses', async () => {
  const f = await recoveryFixture()
  try {
    await f.dom.act(async () => f.latest.sendText('Hello'))
    await f.dom.act(async () => {
      f.instances[0]!.emit({ type: 'response.created' })
      f.instances[0]!.emit({ type: 'response.done', response: { status: 'completed', output: [] } })
    })
    for (let i = 0; i < 4; i++) {
      f.advanceTime(60_000)
      await f.dom.act(async () => f.instances.at(-1)!.drop())
      expect(f.hasRetry()).toBe(true)
      await f.expireRetry()
      expect(f.instances.at(-1)!.events.filter((event) => event.type === 'response.create')).toHaveLength(0)
    }
    expect(f.instances).toHaveLength(5)
  } finally {
    await f.dom.cleanup()
  }
})
