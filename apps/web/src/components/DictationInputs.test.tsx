import { afterEach, beforeEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent } from '@testing-library/dom'
import type { ReactNode } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { QuestionInput } from './QuestionInput'
import { RejectionModal } from './RejectionModal'

let dom: Awaited<ReturnType<typeof acquireDomHarness>>
let client: QueryClient
let oldRecorder: PropertyDescriptor | undefined
let oldMedia: PropertyDescriptor | undefined
let microphoneRequests = 0
beforeEach(async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  oldRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder')
  oldMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: class {} })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        microphoneRequests++
        throw new Error('Must not record')
      },
    },
  })
  microphoneRequests = 0
})
afterEach(async () => {
  client.clear()
  if (oldRecorder) Object.defineProperty(globalThis, 'MediaRecorder', oldRecorder)
  else Reflect.deleteProperty(globalThis, 'MediaRecorder')
  if (oldMedia) Object.defineProperty(navigator, 'mediaDevices', oldMedia)
  else Reflect.deleteProperty(navigator, 'mediaDevices')
  await dom.cleanup()
})
async function render(node: ReactNode, transcriptionEnabled: boolean) {
  client.setQueryData(queryKeys.voice.status(), { enabled: true, realtimeEnabled: true, transcriptionEnabled })
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>))
}
for (const surface of ['question', 'rejection'] as const) {
  const component = () =>
    surface === 'question' ? (
      <QuestionInput
        questionData={{ questions: [{ id: 'q', type: 'text', question: 'Which branch?' }] }}
        onSubmit={() => {}}
      />
    ) : (
      <RejectionModal isOpen onClose={() => {}} onConfirm={() => {}} />
    )
  test(`${surface} hides dictation and does not intercept its recording shortcut when disabled`, async () => {
    await render(component(), false)
    expect(document.querySelector('button[title^="Record voice"]')).toBeNull()
    const textarea = document.querySelector('textarea')!
    await dom.act(async () => {
      fireEvent.focus(textarea)
      expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true)
    })
    expect(microphoneRequests).toBe(0)
  })
  test(`${surface} offers dictation when enabled`, async () => {
    await render(component(), true)
    expect(document.querySelector('button[title^="Record voice"]')).not.toBeNull()
  })
}
