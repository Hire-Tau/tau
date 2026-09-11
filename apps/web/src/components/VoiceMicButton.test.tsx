import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queries } from '../queryOptions'
import { VoiceMicButton } from './VoiceMicButton'

// The mic is gated INSIDE this component, not only at call sites, because
// every consumer hits the same transcribe endpoint — and call-site gating
// alone already missed two surfaces once (QuestionInput and RejectionModal
// kept offering a mic that silently failed without an OpenAI key). These
// tests pin the source-level gate so a new consumer cannot reintroduce that.

function render(enabled: boolean | null) {
  const qc = new QueryClient()
  if (enabled !== null) qc.setQueryData(queries.voice.status().queryKey, { enabled })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <VoiceMicButton
        state="idle"
        elapsed={0}
        isSupported
        isHoldMode={false}
        beginPress={() => {}}
        endPress={() => {}}
        cancelPress={() => {}}
      />
    </QueryClientProvider>
  )
}

describe('VoiceMicButton voice gating', () => {
  test('renders when the server reports voice enabled', () => {
    expect(render(true)).toContain('button')
  })

  test('renders nothing when the server reports voice disabled', () => {
    expect(render(false)).toBe('')
  })

  // Loading → hidden: flashing a control that vanishes on key-less instances
  // is worse than it appearing a beat late on configured ones.
  test('renders nothing while the capability is still unknown', () => {
    expect(render(null)).toBe('')
  })
})
