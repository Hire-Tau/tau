import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkStreamDeliveryExplanation } from '@tau/shared'
import { WorkStreamDeliverySetupCallout } from './WorkStreamDeliverySetupCallout'

type Stream = Parameters<typeof WorkStreamDeliverySetupCallout>[0]['stream']

function setupStream(explanation?: WorkStreamDeliveryExplanation, overrides: Partial<Stream> = {}): Stream {
  return {
    id: '0f4f27b2-9c2e-4a33-8a44-64ab1ff54d16',
    number: 234,
    status: 'active',
    // The server's legacy derived vocabulary maps delivery_setup onto 'blocked'.
    derivedState: 'blocked',
    openWaits: [],
    completionMode: 'pr-merge',
    metadata: {
      codeHost: {
        integration: 'github',
        repository: 'intentional/design',
        changeRequest: { number: 51, url: 'https://github.com/intentional/design/pull/51' },
      },
    },
    ...(explanation ? { delivery: { kind: 'setup' as const, explanation } } : { delivery: { kind: 'setup' as const } }),
    ...overrides,
  }
}

test('renders only in the delivery_setup presentation state', () => {
  const callout = renderToStaticMarkup(<WorkStreamDeliverySetupCallout stream={setupStream()} />)
  expect(callout).toContain('What is blocking completion')
  expect(
    renderToStaticMarkup(
      <WorkStreamDeliverySetupCallout
        stream={setupStream(undefined, { delivery: { kind: 'merge' as const }, derivedState: 'in_review' })}
      />
    )
  ).toBe('')
  expect(
    renderToStaticMarkup(
      <WorkStreamDeliverySetupCallout
        stream={setupStream(undefined, {
          delivery: { kind: 'external' as const, explanation: { pullRequests: [{ number: 51, state: 'open' }] } },
        })}
      />
    )
  ).toBe('')
  expect(
    renderToStaticMarkup(
      <WorkStreamDeliverySetupCallout
        stream={setupStream(undefined, { delivery: undefined, derivedState: 'in_progress' })}
      />
    )
  ).toBe('')
  // An open manual wait reinterprets the presentation state; the wait panel owns the surface.
  expect(
    renderToStaticMarkup(
      <WorkStreamDeliverySetupCallout stream={setupStream(undefined, { openWaits: [{ type: 'manual' }] })} />
    )
  ).toBe('')
  expect(
    renderToStaticMarkup(<WorkStreamDeliverySetupCallout stream={setupStream(undefined, { status: 'done' })} />)
  ).toBe('')
})

test('sparse facts degrade to the generic explanation without empty rows', () => {
  const html = renderToStaticMarkup(<WorkStreamDeliverySetupCallout stream={setupStream()} />)
  expect(html).toContain('delivery setup is incomplete')
  expect(html).toContain('Completion mode pr-merge')
  expect(html).toContain('Check the delivery requirements on the linked pull request')
  expect(html).not.toContain('branch protection')
  expect(html).not.toContain('set-meta')
  expect(html).not.toContain('undefined')
})

test('a branch mismatch with a blocked merge surfaces the signature next step', () => {
  const html = renderToStaticMarkup(
    <WorkStreamDeliverySetupCallout
      stream={setupStream({
        setupReason: 'branch-mismatch',
        branchMismatch: { streamBranch: 'work/0f4f27b2', pullRequestBranch: 'rework/head' },
        pullRequests: [{ number: 51, state: 'open' }],
        gates: { mergeState: 'blocked', checksState: 'success', reviewDecision: 'approved' },
      })}
    />
  )
  expect(html).toContain('The tracked pull request')
  expect(html).toContain('work/0f4f27b2')
  expect(html).toContain('rework/head')
  expect(html).toContain('blocked by branch protection')
  expect(html).toContain('required commit signature')
  expect(html).toContain('Next step')
  expect(html).toContain('Signing Key')
  expect(html).toContain('github.com/settings/keys')
  expect(html).toContain('push a signed head commit')
  expect(html).toContain('merge the pull request via the GitHub UI')
})

test('an unbound stream shows the exact bind command as the next step', () => {
  const html = renderToStaticMarkup(
    <WorkStreamDeliverySetupCallout
      stream={setupStream({ setupReason: 'unbound' }, { metadata: { git: { branch: 'work/x' } } })}
    />
  )
  expect(html).toContain('No delivery pull request is bound')
  expect(html).toContain('Next step')
  expect(html).toContain(
    'tau workstream set-meta 234 codeHost &#x27;{&quot;integration&quot;:&quot;github&quot;,&quot;repository&quot;:&quot;&lt;owner/repo&gt;&quot;,&quot;changeRequest&quot;:{&quot;number&quot;:&lt;pr-number&gt;,&quot;url&quot;:&quot;&lt;pr-url&gt;&quot;}}&#x27;'
  )
})

test('a bound but untracked flow explains the GitHub-UI merge path', () => {
  const html = renderToStaticMarkup(
    <WorkStreamDeliverySetupCallout
      stream={setupStream({
        setupReason: 'not-following-changes',
        pullRequests: [{ number: 51, state: 'open' }],
      })}
    />
  )
  expect(html).toContain('follow code-host changes')
  expect(html).toContain('Merge the pull request via the GitHub UI, then finish delivery')
})

test('direct-merge facts and tracked multi-PR setups render without breaking', () => {
  const direct = renderToStaticMarkup(
    <WorkStreamDeliverySetupCallout
      stream={setupStream(
        { setupReason: 'direct-merge-facts' },
        { completionMode: 'direct-merge' as Stream['completionMode'], metadata: {} }
      )}
    />
  )
  expect(direct).toContain('direct-merge')
  expect(direct).toContain('git.commit')
  expect(direct).toContain('git.baseBranch')
  const multi = renderToStaticMarkup(
    <WorkStreamDeliverySetupCallout
      stream={setupStream({
        setupReason: 'branch-mismatch',
        branchMismatch: { streamBaseBranch: 'main', pullRequestBaseBranch: 'develop' },
        pullRequests: [
          { number: 51, state: 'open' },
          { number: 52, state: 'merged' },
        ],
        gates: { mergeState: 'blocked', checksState: 'pending' },
      })}
    />
  )
  expect(multi).toContain('Stream base branch main')
  expect(multi).toContain('pull request base branch develop')
  expect(multi).toContain('Checks are still running')
})
