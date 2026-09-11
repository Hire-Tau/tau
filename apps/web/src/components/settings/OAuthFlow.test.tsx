import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { acquireDomHarness } from '../../test/domHarness'
import { SelectStep, CodeStep, DeviceCodeStep, ErrorStep } from './ProviderAuthSection'

describe('OAuth flow steps', () => {
  test('SelectStep renders prompt and options', () => {
    const html = renderToStaticMarkup(
      <SelectStep
        need={{ kind: 'select', message: 'Pick a login method', options: [{ id: 'device', label: 'Device code' }] }}
        isPending={false}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )

    expect(html).toContain('Pick a login method')
    expect(html).toContain('Device code')
  })

  test('SelectStep surfaces device code as primary and browser login as a fallback for the OpenAI Codex choice', () => {
    const html = renderToStaticMarkup(
      <SelectStep
        need={{
          kind: 'select',
          message: 'Select OpenAI Codex login method:',
          options: [
            { id: 'browser', label: 'Browser login (default)' },
            { id: 'device_code', label: 'Device code login (headless)' },
          ],
        }}
        isPending={false}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )

    // Device code is presented as the primary action, ahead of the browser fallback.
    const deviceIndex = html.indexOf('Device code')
    const browserFallbackIndex = html.indexOf('browser login instead')
    expect(deviceIndex).toBeGreaterThan(-1)
    expect(browserFallbackIndex).toBeGreaterThan(-1)
    expect(deviceIndex).toBeLessThan(browserFallbackIndex)
    // Expectation-setting copy for the browser fallback: warns about the
    // localhost redirect failing to load, but does NOT claim there's a
    // paste field on this screen (that field is on CodeStep, one screen
    // later).
    expect(html).toContain('fail to load')
    expect(html).not.toContain('paste it back here')
    expect(html).toContain('next screen')
  })

  test('CodeStep renders auth link and instructions', () => {
    const html = renderToStaticMarkup(
      <CodeStep
        need={{ kind: 'code', authUrl: 'https://example.com/auth', instructions: 'Paste code' }}
        code=""
        onCodeChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    )

    expect(html).toContain('Complete login in the browser')
    expect(html).toContain('https://example.com/auth')
    expect(html).toContain('Paste code')
  })

  test('CodeStep sets expectations about the localhost redirect failing to load', () => {
    const html = renderToStaticMarkup(
      <CodeStep
        need={{ kind: 'code', authUrl: 'https://example.com/auth' }}
        code=""
        onCodeChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    )

    expect(html).toContain('fail to load')
    expect(html).toContain('expected')
    expect(html).toContain('address bar')
  })

  test('DeviceCodeStep renders verification URI and user code', () => {
    const html = renderToStaticMarkup(
      <DeviceCodeStep
        need={{ kind: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.com/device' }}
        onCancel={() => {}}
      />
    )

    expect(html).toContain('ABCD-1234')
    expect(html).toContain('https://example.com/device')
    expect(html).toContain('Waiting for authorization')
  })

  test('DeviceCodeStep renders a copy button for the user code', () => {
    const html = renderToStaticMarkup(
      <DeviceCodeStep
        need={{ kind: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.com/device' }}
        onCancel={() => {}}
      />
    )

    expect(html).toContain('Copy')
  })

  describe('DeviceCodeStep copy button interaction', () => {
    let dom: Awaited<ReturnType<typeof acquireDomHarness>>

    beforeEach(async () => {
      dom = await acquireDomHarness({ url: 'http://localhost/settings' })
    })

    afterEach(async () => {
      await dom.cleanup()
    })

    async function renderDeviceCodeStep() {
      const { root, container } = dom.createRoot()
      await dom.act(async () => {
        root.render(
          <DeviceCodeStep
            need={{ kind: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.com/device' }}
            onCancel={() => {}}
          />
        )
      })
      return container
    }

    test('clicking Copy writes the user code to the clipboard and shows Copied feedback', async () => {
      const writeText = mock(() => Promise.resolve())
      Object.assign(dom.window.navigator.clipboard, { writeText })
      const container = await renderDeviceCodeStep()
      const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Copy')
      expect(button).toBeDefined()

      await dom.act(async () => {
        fireEvent.click(button as Element)
      })

      expect(writeText).toHaveBeenCalledWith('ABCD-1234')
      expect(container.textContent).toContain('Copied')
    })

    test('clicking Copy does not show Copied feedback when the clipboard write rejects', async () => {
      const writeText = mock(() => Promise.reject(new Error('permission denied')))
      Object.assign(dom.window.navigator.clipboard, { writeText })
      const container = await renderDeviceCodeStep()
      const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Copy')
      expect(button).toBeDefined()

      await dom.act(async () => {
        fireEvent.click(button as Element)
        await Promise.resolve()
      })

      expect(writeText).toHaveBeenCalledWith('ABCD-1234')
      expect(container.textContent).not.toContain('Copied')
    })
  })

  test('ErrorStep renders error and actions', () => {
    const html = renderToStaticMarkup(<ErrorStep message="Bad login" onRetry={() => {}} onCancel={() => {}} />)

    expect(html).toContain('Login failed: Bad login')
    expect(html).toContain('Try Again')
  })
})

test('device login expiration is expressed in minutes', () => {
  const html = renderToStaticMarkup(
    <DeviceCodeStep
      need={{
        kind: 'device_code',
        userCode: 'ABCD',
        verificationUri: 'https://example.com/device',
        expiresInSeconds: 900,
      }}
      onCancel={() => {}}
    />
  )
  expect(html).toContain('15 minutes')
  expect(html).not.toContain('900 seconds')
})
