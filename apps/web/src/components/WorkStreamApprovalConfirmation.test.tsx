import { acquireDomHarness } from '../test/domHarness'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Root } from 'react-dom/client'
import { WorkStreamApprovalConfirmation, approvalConfirmationMessage } from './WorkStreamApprovalConfirmation'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

let root: Root | undefined
async function installDom() {
  return (domHarness = await acquireDomHarness({ url: 'http://localhost/' }))
}

async function renderConfirmation(props: Partial<React.ComponentProps<typeof WorkStreamApprovalConfirmation>> = {}) {
  const dom = await installDom()
  const { window } = dom
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  root = domHarness!.createRoot().root
  const onCancel = props.onCancel ?? mock(() => {})
  const onConfirm = props.onConfirm ?? mock(() => {})
  await domHarness!.act(async () =>
    root?.render(
      <WorkStreamApprovalConfirmation
        isOpen
        completionMode="pr-merge"
        completesOnApproval
        isPending={false}
        error={null}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...props}
      />
    )
  )
  return { window, onCancel, onConfirm }
}

describe('WorkStreamApprovalConfirmation', () => {
  test('copy accurately distinguishes every completion mode', () => {
    expect(approvalConfirmationMessage('pr-merge', true)).toBe(
      'Approving completes this work stream even if its pull request has not merged. It does not merge the pull request.'
    )
    expect(approvalConfirmationMessage('pr-auto-merge', true)).toBe(
      'Approving completes this work stream. It does not merge the pull request. If configured and eligible, auto-merge proceeds separately.'
    )
    expect(approvalConfirmationMessage('review-approval', true)).toBe(
      'Approving completes this work stream based on review approval.'
    )
    expect(approvalConfirmationMessage('direct-merge', true)).toBe(
      'Approving completes this work stream under its direct-merge workflow.'
    )
  })

  test('checkpoint approval says the stream continues', async () => {
    const { window } = await renderConfirmation({ completesOnApproval: false })

    expect(window.document.body.textContent).toContain('closes this checkpoint')
    expect(window.document.body.textContent).toContain('continues')
    expect(window.document.body.textContent).not.toContain('completes this work stream')
    expect(window.document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Approve checkpoint?')
  })

  test('cancel does not confirm and button confirmation submits exactly once', async () => {
    const { window, onCancel, onConfirm } = await renderConfirmation()
    const cancel = [...window.document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')
    await domHarness!.act(async () => cancel?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    const confirm = [...window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Approve and complete'
    )
    await domHarness!.act(async () => {
      confirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      confirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('Enter confirms, Escape cancels, and pending/error retry is safe', async () => {
    const { window, onCancel, onConfirm } = await renderConfirmation()
    await domHarness!.act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' })))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    await domHarness!.act(async () =>
      root?.render(
        <WorkStreamApprovalConfirmation
          isOpen
          completionMode="pr-merge"
          isPending
          error={null}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )
    )
    expect(window.document.body.textContent).toContain('Approving…')
    await domHarness!.act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' })))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    await domHarness!.act(async () =>
      root?.render(
        <WorkStreamApprovalConfirmation
          isOpen
          completionMode="pr-merge"
          isPending={false}
          error="Approval failed"
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )
    )
    expect(window.document.body.textContent).toContain('Approval failed')
    await domHarness!.act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }))
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }))
    })
    expect(onConfirm).toHaveBeenCalledTimes(2)

    await domHarness!.act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})
