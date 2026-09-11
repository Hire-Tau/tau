import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'

test('shipped denoiser links as a browser module and initializes processors before and after WASM is ready', async () => {
  const moduleSource = await Bun.file(new URL('../../public/voice/dtln/dtln.js', import.meta.url)).text()
  expect(new Bun.Transpiler({ loader: 'js' }).scan(moduleSource).exports).toContain('default')
  const result = await Bun.build({
    entrypoints: [new URL('../../public/voice/dtln/processor.js', import.meta.url).pathname],
    target: 'browser',
    format: 'iife',
    write: false,
    plugins: [
      {
        name: 'browser-module-urls',
        setup(build) {
          // Browsers resolve versioned module URLs to the same served file.
          build.onResolve({ filter: /\?v=/ }, (args) => ({
            path: new URL(args.path, pathToFileURL(args.importer)).pathname,
          }))
        },
      },
    ],
  })
  expect(result.success).toBe(true)
  let Processor: any
  let markReady!: () => void
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const messages: unknown[] = []
  runInNewContext(await result.outputs[0]!.text(), {
    AudioWorkletGlobalScope: class {},
    AudioWorkletProcessor: class {
      port = {
        postMessage: (message: unknown) => {
          messages.push(message)
          if (message === 'ready') markReady()
        },
      }
    },
    registerProcessor: (_name: string, value: any) => {
      Processor = value
    },
    // AudioWorkletGlobalScope has a full console; the glue binds console.error at load.
    console: { log() {}, warn() {}, error() {} },
    atob,
  })
  const first = new Processor()
  await ready
  expect(first.isModuleReady).toBe(true)
  const second = new Processor()
  expect(second.isModuleReady).toBe(true)
  expect(messages).toEqual(['ready', 'ready'])
  const output = new Float32Array(128)
  {
    for (let i = 0; i < 8; i++) {
      const input = Float32Array.from({ length: 128 }, (_, n) => Math.sin((i * 128 + n) / 10) * 0.1)
      expect(first.process([[input]], [[output]])).toBe(true)
      expect([...output].every(Number.isFinite)).toBe(true)
    }
    expect(messages).toEqual(['ready', 'ready'])
  }
})

test('a failed worklet enables browser noise suppression before using the microphone', async () => {
  const { acquireDomHarness } = await import('../test/domHarness')
  const { RealtimeTransport } = await import('./realtimeTransport')
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  const constraints: MediaTrackConstraints[] = []
  const track = {
    enabled: true,
    stop() {},
    async applyConstraints(value: MediaTrackConstraints) {
      constraints.push(value)
    },
  }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream } })
  const transport = new RealtimeTransport()
  const internal = transport as any
  let attached: unknown
  internal.peerConnection = {}
  internal.audioSender = {
    replaceTrack: async (value: unknown) => {
      attached = value
    },
  }
  internal.createDtlnDenoisedStream = async () => null
  internal.startInputLevelMeter = () => {}
  try {
    await transport.enableAudioInput(true)
    expect(constraints).toEqual([{ noiseSuppression: true }])
    expect(attached).toBe(track)
  } finally {
    await transport.disableAudioInput()
    if (original) Object.defineProperty(navigator, 'mediaDevices', original)
    else Reflect.deleteProperty(navigator, 'mediaDevices')
    await dom.cleanup()
  }
})
