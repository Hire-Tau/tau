import { describe, expect, mock, test } from 'bun:test'
import { useEffect } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { useAgentFileAttachments } from './useAgentFileAttachments'

type DeferredUpload = { resolve(value: any): void; reject(error: unknown): void; progress(value: number): void }
const uploads: DeferredUpload[] = []
const deleteCalls: Array<[string, string]> = []
const uploadFile = mock(
  (_agentId: string, _id: string, _file: File, options: { onProgress(value: number): void }) =>
    new Promise((resolve, reject) => {
      uploads.push({ resolve, reject, progress: options.onProgress })
    })
)
const deleteFile = mock(async (agentId: string, id: string) => {
  deleteCalls.push([agentId, id])
})

type Hook = ReturnType<typeof useAgentFileAttachments>
type SetTextCall = { value: string; caret?: number; options?: { focus?: boolean } }
function Harness({
  agentId,
  text,
  expose,
  setText,
}: {
  agentId: string
  text: { current: string }
  expose(hook: Hook): void
  setText(value: string, caret?: number, options?: { focus?: boolean }): void
}) {
  const hook = useAgentFileAttachments({
    agentId,
    getText: () => text.current,
    setText: (value, caret, options) => setText(value, caret, options),
    uploadFile,
    deleteFile,
  })
  useEffect(() => expose(hook), [expose, hook])
  return null
}

async function mount(agentId = 'agent-a') {
  uploads.length = 0
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  try {
    const { window } = dom
    const { root } = dom.createRoot()
    const text = { current: 'draft' }
    let hook!: Hook
    const expose = (value: Hook) => {
      hook = value
    }
    const setTextCalls: SetTextCall[] = []
    const setText = (value: string, caret?: number, options?: { focus?: boolean }) => {
      setTextCalls.push({ value, caret, options })
      text.current = value
    }
    await dom.act(async () => root.render(<Harness agentId={agentId} text={text} expose={expose} setText={setText} />))
    return { root, window, dom, text, hook: () => hook, expose, setText, setTextCalls }
  } catch (error) {
    await dom.cleanup()
    throw error
  }
}

async function add(mounted: Awaited<ReturnType<typeof mount>>) {
  await mounted.dom.act(async () => {
    mounted.hook().addFile(new File(['x'], 'x.txt'))
  })
  const item = mounted.hook().files[0]
  expect(item).toBeDefined()
  return item
}

describe('useAgentFileAttachments lifecycle', () => {
  test('re-deletes after a removed upload settles', async () => {
    deleteCalls.length = 0
    const mounted = await mount()
    try {
      const item = await add(mounted)
      await mounted.dom.act(async () => {
        await mounted.hook().removeFile(item.id)
      })
      expect(deleteCalls).toEqual([['agent-a', item.id]])
      await mounted.dom.act(async () => uploads[0].resolve({ path: item.path }))
      expect(deleteCalls).toEqual([
        ['agent-a', item.id],
        ['agent-a', item.id],
      ])
      await mounted.dom.act(async () => mounted.root.unmount())
    } finally {
      await mounted.dom.cleanup()
    }
  })

  test('agent switch removes owned refs and deletes with the old owner', async () => {
    deleteCalls.length = 0
    const mounted = await mount()
    try {
      const item = await add(mounted)
      expect(mounted.text.current).toContain(item.reference)
      await mounted.dom.act(async () => uploads[0].progress(0.5))
      expect(mounted.hook().files[0].progress).toBe(0.5)
      expect(mounted.text.current).toContain(item.reference)
      expect(deleteCalls).toEqual([])
      await mounted.dom.act(async () =>
        mounted.root.render(
          <Harness agentId="agent-b" text={mounted.text} expose={mounted.expose} setText={mounted.setText} />
        )
      )
      expect(mounted.text.current).not.toContain(item.reference)
      expect(mounted.hook().files).toEqual([])
      expect(deleteCalls).toContainEqual(['agent-a', item.id])
      await mounted.dom.act(async () => mounted.root.unmount())
    } finally {
      await mounted.dom.cleanup()
    }
  })

  for (const lifecycle of ['agent switch', 'unmount'] as const) {
    for (const success of [true, false]) {
      test(`${lifecycle} during send ${success ? 'transfers on success' : 'deletes on rejection'}`, async () => {
        deleteCalls.length = 0
        const mounted = await mount()
        try {
          const item = await add(mounted)
          mounted.hook().beginOwnershipTransfer()
          if (lifecycle === 'agent switch') {
            await mounted.dom.act(async () =>
              mounted.root.render(
                <Harness agentId="agent-b" text={mounted.text} expose={mounted.expose} setText={mounted.setText} />
              )
            )
          } else {
            await mounted.dom.act(async () => mounted.root.unmount())
          }
          expect(deleteCalls).toEqual([])
          mounted.hook().settleOwnershipTransfer(success)
          expect(deleteCalls).toEqual(success ? [] : [['agent-a', item.id]])
          if (lifecycle === 'agent switch') await mounted.dom.act(async () => mounted.root.unmount())
        } finally {
          await mounted.dom.cleanup()
        }
      })
    }
  }

  // The provisional reference is a guess at the container layout; only the
  // server knows where the file really landed on the active runtime (on host,
  // <HOME_DIR>/private/<sandboxId>/...). The composer must adopt that answer
  // itself — the agent can only open the path the server reports.
  test('adopts the server path over the provisional reference', async () => {
    const mounted = await mount()
    try {
      const item = await add(mounted)
      const serverPath = `/Users/n/.tau/private/agent_1/chat-attachments/${item.id}/x.txt`
      expect(mounted.text.current).toContain(item.reference)
      await mounted.dom.act(async () => uploads[0].resolve({ path: serverPath }))
      expect(mounted.text.current).toContain(`@${serverPath}`)
      expect(mounted.text.current).not.toContain(item.reference)
      expect(mounted.hook().files[0].status).toBe('done')
      expect(mounted.hook().files[0].error).toBeUndefined()
      expect(mounted.hook().blocked).toBe(false)
      await mounted.dom.act(async () => mounted.root.unmount())
    } finally {
      await mounted.dom.cleanup()
    }
  })

  // Defence in depth behind uploadAgentFile's own check: a response without a
  // usable path must never be adopted, or the composer rewrites the user's
  // token to `@undefined` and unblocks sending.
  test('refuses a response without a usable path', async () => {
    const mounted = await mount()
    try {
      const item = await add(mounted)
      await mounted.dom.act(async () => uploads[0].resolve({}))
      expect(mounted.text.current).toContain(item.reference)
      expect(mounted.text.current).not.toContain('@undefined')
      expect(mounted.hook().files[0].status).toBe('error')
      expect(mounted.hook().files[0].error).toBe('Upload failed (malformed response)')
      expect(mounted.hook().blocked).toBe(true)
      await mounted.dom.act(async () => mounted.root.unmount())
    } finally {
      await mounted.dom.cleanup()
    }
  })

  // Adoption rewrites the token in place, but the provisional spelling can come
  // back (an undo, a re-paste) or survive an adoption that matched nothing —
  // cleanup must strip BOTH spellings, not just the current one.
  test('cleanup strips the provisional token as well as the adopted one', async () => {
    const mounted = await mount()
    try {
      const item = await add(mounted)
      const serverPath = `/Users/n/.tau/private/agent_1/chat-attachments/${item.id}/x.txt`
      await mounted.dom.act(async () => uploads[0].resolve({ path: serverPath }))
      mounted.text.current += ` ${item.reference} `
      expect(mounted.text.current).toContain(item.reference)
      await mounted.dom.act(async () => {
        await mounted.hook().removeFile(item.id)
      })
      expect(mounted.text.current).not.toContain(item.reference)
      expect(mounted.text.current).not.toContain(`@${serverPath}`)
      await mounted.dom.act(async () => mounted.root.unmount())
    } finally {
      await mounted.dom.cleanup()
    }
  })

  test('adoption and removal affect exact tokens only', async () => {
    const mounted = await mount()
    try {
      const item = await add(mounted)
      const canonical = item.path.replace('x.txt', 'canonical.txt')
      mounted.text.current += ` @${canonical} keep  spacing `
      await mounted.dom.act(async () => uploads[0].resolve({ path: canonical }))
      expect(mounted.text.current).not.toContain(item.reference)
      expect(mounted.text.current).toContain(`@${canonical}`)
      await mounted.dom.act(async () => {
        await mounted.hook().removeFile(item.id)
      })
      expect(mounted.text.current).toBe('draft    keep  spacing ')
      await mounted.dom.act(async () => mounted.root.unmount())
    } finally {
      await mounted.dom.cleanup()
    }
  })

  // Explicit user actions (add/remove) already refocus the composer via
  // setText's { focus: true } option — these two pin that contract.
  test('addFile refocuses the composer (explicit user action)', async () => {
    const mounted = await mount()
    try {
      await add(mounted)
      expect(mounted.setTextCalls.at(-1)?.options).toEqual({ focus: true })
      await mounted.dom.act(async () => mounted.root.unmount())
    } finally {
      await mounted.dom.cleanup()
    }
  })

  test('retryFile refocuses the composer like add/remove (explicit user action)', async () => {
    const mounted = await mount()
    try {
      const item = await add(mounted)
      // Drive the upload to error so retryFile becomes the user's action.
      await mounted.dom.act(async () => uploads[0].reject(new Error('boom')))
      expect(mounted.hook().files[0].status).toBe('error')
      mounted.setTextCalls.length = 0
      await mounted.dom.act(async () => {
        await mounted.hook().retryFile(item.id)
      })
      expect(mounted.hook().files[0].status).toBe('uploading')
      expect(mounted.setTextCalls.at(-1)?.options).toEqual({ focus: true })
      await mounted.dom.act(async () => mounted.root.unmount())
    } finally {
      await mounted.dom.cleanup()
    }
  })
})
