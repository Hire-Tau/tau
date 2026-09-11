import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test } from 'bun:test'
import type { PendingAction } from '@tau/shared'
import { acquireDomHarness } from '../test/domHarness'
import { ReactQueryHooksProvider } from '../reactQueryHooks'
import { AccountFeedVisit } from './FeedVisitSummary'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

test('waits for successful visible loading, freezes the visit baseline, and acknowledges once', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  let ready = false
  let fetched = false
  let workSuccess = false
  let lastVisitedAt: string | null = '2026-01-01T00:00:00.000Z'
  const observedAt = '2026-01-03T00:00:00.000Z'
  const saved: string[] = []
  const countWindows: unknown[][] = []
  const acknowledge = async (at: string) => {
    saved.push(at)
    return { lastVisitedAt: at }
  }
  const hooks = {
    useQuery: ((options: { queryKey: unknown[] }) => {
      const key = options.queryKey
      if (key[0] === 'auth')
        return { isSuccess: true, isFetchedAfterMount: fetched, data: { lastVisitedAt, observedAt } }
      return { isSuccess: workSuccess }
    }) as never,
    useInfiniteQuery: ((options: { queryKey: unknown[] }) => {
      countWindows.push(options.queryKey.slice(2, 4))
      return {
        isSuccess: true,
        data: {
          pages: [
            {
              totalCount: 12,
              items: [{ id: 'completed-work', title: 'Ship the fix', completedAt: '2026-01-02T12:00:00.000Z' }],
            },
          ],
        },
      }
    }) as never,
  }
  const actions = [
    { createdAt: '2026-01-02T00:00:00.000Z' },
    { createdAt: '2025-12-01T00:00:00.000Z' },
  ] as PendingAction[]
  const render = () =>
    dom!.act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/?squad=test']}>
          <ReactQueryHooksProvider hooks={hooks}>
            <AccountFeedVisit
              userId="one"
              ActionCenter={({ actions }) => <div>{actions.length} new question</div>}
              actions={actions}
              ready={ready}
              acknowledge={acknowledge}
            />
          </ReactQueryHooksProvider>
        </MemoryRouter>
      )
    })
  await render()
  expect(saved).toEqual([])
  fetched = true
  await render()
  expect(saved).toEqual([])
  ready = true
  workSuccess = true
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'hidden' })
  await render()
  expect(saved).toEqual([])
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' })
  await dom.act(async () => {
    dom!.window.document.dispatchEvent(new dom!.window.Event('visibilitychange'))
  })
  expect(saved).toEqual([observedAt])
  expect(dom.window.document.body.textContent).toContain('12 completed · 1 needs your input')
  expect(dom.window.document.body.textContent).toContain('Ship the fix')
  expect(dom.window.document.body.textContent).toContain('1 new question')
  expect(dom.window.document.querySelector('a')?.getAttribute('href')).toBe('/?squad=test&ws=completed-work')
  const section = dom.window.document.querySelector('details')!
  expect(section.open).toBe(true)
  await dom.act(async () => {
    dom!.window.document.querySelector('summary')!.click()
  })
  expect(section.open).toBe(false)
  lastVisitedAt = observedAt
  await render()
  expect(countWindows.at(-1)).toEqual(['2026-01-01T00:00:00.000Z', observedAt])
  expect(saved).toEqual([observedAt])
})

test('first visit establishes a watermark without claiming previous completions', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root } = dom.createRoot()
  const saved: string[] = []
  const observedAt = '2026-01-03T00:00:00.000Z'
  const hooks = {
    useQuery: ((options: { queryKey: unknown[] }) =>
      options.queryKey[0] === 'auth'
        ? { isSuccess: true, isFetchedAfterMount: true, data: { lastVisitedAt: null, observedAt } }
        : { isSuccess: true }) as never,
    useInfiniteQuery: (() => ({ isSuccess: true, data: { pages: [{ totalCount: 100, items: [] }] } })) as never,
  }
  await dom.act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/?squad=test']}>
        <ReactQueryHooksProvider hooks={hooks}>
          <AccountFeedVisit
            userId="new"
            actions={[]}
            ready
            acknowledge={async (at) => {
              saved.push(at)
              return { lastVisitedAt: at }
            }}
          />
        </ReactQueryHooksProvider>
      </MemoryRouter>
    )
  })
  expect(saved).toEqual([observedAt])
  expect(dom.window.document.body.textContent).not.toContain('Since your last visit')
})
