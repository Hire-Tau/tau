import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

export { act }

export interface RenderHookResult<T> {
  result: { current: T }
  rerender: () => Promise<void>
  unmount: () => void
}

export async function renderHook<T>(
  useHook: () => T,
  options?: { wrapper?: ComponentType<{ children: ReactNode }> }
): Promise<RenderHookResult<T>> {
  const Wrapper = options?.wrapper
  const result = { current: undefined as unknown as T }
  function Probe() {
    result.current = useHook()
    return null
  }
  const tree = (): ReactNode =>
    Wrapper ? createElement(Wrapper, { children: createElement(Probe) }) : createElement(Probe)
  const container = (globalThis as unknown as { document: Document }).document.createElement('div')
  const root = createRoot(container)
  // Use async act so that microtasks (e.g. React Query's initial fetch) flush inside the
  // act boundary and don't generate "not wrapped in act" warnings.
  await act(async () => {
    root.render(tree())
    await Promise.resolve()
  })
  // Second flush: chained microtasks (e.g. getActiveExecution().then(setExecutionStatus))
  // settle after the first act boundary. A trailing async act drains them.
  await act(async () => {
    await Promise.resolve()
  })
  async function rerender() {
    await act(async () => {
      root.render(tree())
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
  }
  return {
    result,
    rerender,
    unmount: () => act(() => root.unmount()),
  }
}

export async function waitFor(
  check: () => void,
  { timeout = 1000, interval = 10 }: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start <= timeout) {
    try {
      check()
      return
    } catch (err) {
      lastErr = err
      await act(async () => {
        await new Promise((r) => setTimeout(r, interval))
      })
    }
  }
  throw lastErr
}
