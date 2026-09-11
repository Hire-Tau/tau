import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { acquireDomHarness } from '../../test/domHarness'
import { CompatibleCapabilityWarnings, CompatibleProviderSetup } from './ProviderAuthSection'

afterEach(() => {
  // Each mounted test restores fetch itself before releasing DOM ownership.
})

describe('compatible provider UI', () => {
  test('does not probe on mount, refuses Primary, and saves the explicit fallback', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const original = globalThis.fetch
    const dom = await acquireDomHarness({ url: 'http://localhost/settings' })
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined })
      if (url.endsWith('/model-tiers'))
        return Response.json([
          { slug: 'fast', label: 'Fast', description: null, chain: 'openai:gpt:low', sortOrder: 1, usedByCount: 1 },
        ])
      if (url.endsWith('/provider-auth/openai-compatible/probe'))
        return Response.json({
          models: ['qwen'],
          capabilities: { tools: false, contextWindow: 8192, probedAt: 'now' },
          contextWindowFloor: 16384,
        })
      if (url.endsWith('/provider-auth/openai-compatible/accounts'))
        return Response.json({ account: { id: 'a' }, models: ['qwen'] }, { status: 201 })
      if (url.includes('/model-tiers/fast')) return Response.json({ slug: 'fast', chain: 'openai:gpt:low' })
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    dom.window.fetch = globalThis.fetch
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
      const rendered = dom.createRoot()
      await dom.act(async () =>
        rendered.root.render(
          <QueryClientProvider client={client}>
            <CompatibleProviderSetup canWrite />
          </QueryClientProvider>
        )
      )
      await dom.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(calls.some((call) => call.url.includes('/openai-compatible/probe'))).toBe(false)
      const setValue = async (label: string, value: string) => {
        const input = dom.window.document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
        await dom.act(async () => fireEvent.input(input, { target: { value } }))
      }
      await setValue('Custom server URL', 'http://localhost:8080/v1')
      await setValue('Provider ID', 'local')
      await setValue('Model ID', 'qwen')
      const verify = [...dom.window.document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Verify capabilities')
      ) as HTMLButtonElement
      expect(verify.disabled).toBe(false)
      await dom.act(async () => {
        fireEvent.click(verify)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(calls.some((call) => call.url.includes('/openai-compatible/probe'))).toBe(true)
      const primary = dom.window.document.querySelector('input[type="radio"]') as HTMLInputElement
      expect(primary.disabled).toBe(true)
      expect(dom.window.document.body.textContent).toContain('tool-less model cannot be Primary')
      const checkbox = dom.window.document.querySelector('input[type="checkbox"]') as HTMLInputElement
      await dom.act(async () => fireEvent.click(checkbox))
      const save = [...dom.window.document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Add provider and assign tiers')
      ) as HTMLButtonElement
      await dom.act(async () => {
        fireEvent.click(save)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(calls.find((call) => call.url.includes('/model-tiers/fast'))?.body).toContain('local:qwen')
    } finally {
      globalThis.fetch = original
      await dom.cleanup()
    }
  })

  test('renders tool refusal and configured context warning', () => {
    const html = renderToStaticMarkup(
      <CompatibleCapabilityWarnings tools={false} contextWindow={4096} contextFloor={8192} />
    )
    expect(html).toContain('tool-less model cannot be Primary')
    expect(html).toContain('Context window is below 8192')
  })

  test('visibly labels and explains every connection field', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CompatibleProviderSetup canWrite />
      </QueryClientProvider>
    )

    expect(html).toContain('Server URL')
    expect(html).toContain('Provider ID')
    expect(html).toContain('Short prefix used in model specs')
    expect(html).toContain('Model ID')
    expect(html).toContain('exact model name exposed by the server')
    expect(html).toContain('API key (optional)')
    expect(html).toContain('Only needed when the server requires authentication')
  })
})
