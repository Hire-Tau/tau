import { randomUUID } from 'node:crypto'
import { describe, expect, mock, test } from 'bun:test'
import { ContentSafety } from './content-safety'
import { wrapToolWithOutputRedaction, wrapToolsWithOutputRedaction } from './tool-output-redaction'

function tool(name: string, result: unknown) {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute: async () => result,
  } as never
}

function toolWith(execute: (...args: unknown[]) => Promise<unknown>) {
  return {
    name: 'generated-tool',
    label: 'generated-tool',
    description: 'generated-tool',
    parameters: {} as never,
    execute,
  } as never
}

describe('inbound tool-output redaction', () => {
  test('replaces a stored secret in tool output before the model sees it', async () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'GITHUB_TOKEN', value: canary }])
    const wrapped = wrapToolWithOutputRedaction(
      tool('bash', { content: [{ type: 'text', text: `token is ${canary}` }], details: {} }),
      safety
    )

    const result = await (wrapped as never as { execute: () => Promise<{ content: { text: string }[] }> }).execute()

    expect(result.content[0]!.text).toBe('token is [REDACTED_SECRET_ENV:GITHUB_TOKEN]')
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  test('completes the tool call rather than failing it', async () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'K', value: canary }])
    const wrapped = wrapToolWithOutputRedaction(
      tool('bash', { content: [{ type: 'text', text: canary }], details: { exitCode: 0 } }),
      safety
    )

    const result = await (wrapped as never as { execute: () => Promise<unknown> }).execute()

    expect(result).toEqual({ content: [{ type: 'text', text: '[REDACTED_SECRET_ENV:K]' }], details: { exitCode: 0 } })
  })

  test('leaves output without a secret byte-for-byte identical', async () => {
    const safety = ContentSafety.fromSecretEntries([{ key: 'K', value: `CANARY_${randomUUID()}` }])
    const content = [{ type: 'text', text: 'ordinary output with no secret' }]
    const wrapped = wrapToolWithOutputRedaction(tool('bash', { content, details: {} }), safety)

    const result = await (wrapped as never as { execute: () => Promise<{ content: unknown }> }).execute()

    expect(result.content).toEqual(content)
  })

  test('wraps every registered tool', async () => {
    const canary = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'K', value: canary }])
    const wrapped = wrapToolsWithOutputRedaction(
      [
        tool('bash', { content: [{ type: 'text', text: canary }], details: {} }),
        tool('squad_bash', { content: [{ type: 'text', text: canary }], details: {} }),
      ],
      safety
    )

    for (const item of wrapped) {
      const result = await (item as never as { execute: () => Promise<unknown> }).execute()
      expect(JSON.stringify(result)).not.toContain(canary)
    }
  })
})

describe('post-execution stored-key audit at the inbound boundary', () => {
  test('reports stored keys as already executed while returning redacted content', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const order: string[] = []
    const execute = mock(async () => {
      order.push('execute')
      return { content: [{ type: 'text', text: value }], details: { exitCode: 0 } }
    })
    const detections: Array<{ toolCallId: string; storedKeys: readonly string[] }> = []
    const wrapped = wrapToolWithOutputRedaction(toolWith(execute), safety, (event) => {
      order.push('callback')
      detections.push(event)
    })

    const result = await (
      wrapped as never as {
        execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details: unknown }>
      }
    ).execute('call-1', {}, undefined, undefined, {})

    // The original tool already ran when this boundary observes the match, so
    // the report is post-execution by construction: execute first, then the
    // callback, then the redacted return reaches the caller.
    expect(order).toEqual(['execute', 'callback'])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.content).toEqual([{ type: 'text', text: '[REDACTED_SECRET_ENV:SYNTHETIC_KEY]' }])
    expect(result.details).toEqual({ exitCode: 0 })
    expect(detections).toEqual([{ toolCallId: 'call-1', storedKeys: ['SYNTHETIC_KEY'] }])
    expect(JSON.stringify({ result, detections })).not.toContain(value)
  })

  test('reports each stored key of a multi-secret result once through one event', async () => {
    const first = `CANARY_SECRET_${randomUUID()}`
    const second = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([
      { key: 'SYNTHETIC_A', value: first },
      { key: 'SYNTHETIC_B', value: second },
    ])
    const detections: Array<{ toolCallId: string; storedKeys: readonly string[] }> = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content: [{ type: 'text', text: `${first}:${second}` }], details: {} })),
      safety,
      (event) => {
        detections.push(event)
      }
    )

    const result = await (
      wrapped as never as { execute: (id: string) => Promise<{ content: { type: string; text: string }[] }> }
    ).execute('call-2')

    expect(result.content).toEqual([
      { type: 'text', text: '[REDACTED_SECRET_ENV:SYNTHETIC_A]:[REDACTED_SECRET_ENV:SYNTHETIC_B]' },
    ])
    expect(detections).toEqual([{ toolCallId: 'call-2', storedKeys: ['SYNTHETIC_A', 'SYNTHETIC_B'] }])
    expect(JSON.stringify({ result, detections })).not.toContain(first)
    expect(JSON.stringify({ result, detections })).not.toContain(second)
  })

  test('redacts a heuristic credential without invoking the stored-key callback', async () => {
    const credential = `ghp_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`
    const safety = ContentSafety.fromSecretEntries([])
    const detections: unknown[] = []
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content: [{ type: 'text', text: `token ${credential}` }], details: {} })),
      safety,
      (event) => {
        detections.push(event)
      }
    )

    const result = await (
      wrapped as never as { execute: (id: string) => Promise<{ content: { type: string; text: string }[] }> }
    ).execute('call-3')

    expect(result.content).toEqual([{ type: 'text', text: 'token [REDACTED_CREDENTIAL]' }])
    expect(detections).toEqual([])
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  test('leaves a secret-free result byte-for-byte identical and unreported', async () => {
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value: `CANARY_${randomUUID()}` }])
    const detections: unknown[] = []
    const content = [{ type: 'text', text: 'ordinary output with no secret' }]
    const wrapped = wrapToolWithOutputRedaction(
      toolWith(async () => ({ content, details: { exitCode: 0 } })),
      safety,
      (event) => {
        detections.push(event)
      }
    )

    const result = await (
      wrapped as never as { execute: (id: string) => Promise<{ content: unknown[]; details: unknown }> }
    ).execute('call-4')

    expect(result.content).toEqual(content)
    expect(result.details).toEqual({ exitCode: 0 })
    expect(detections).toEqual([])
  })

  test('threads the callback through every wrapped tool', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const detections: Array<{ toolCallId: string }> = []
    const onStoredToolResult = (event: { toolCallId: string }) => {
      detections.push(event)
    }
    const wrapped = wrapToolsWithOutputRedaction(
      [
        toolWith(async () => ({ content: [{ type: 'text', text: value }] })),
        toolWith(async () => ({ content: [{ type: 'text', text: value }] })),
      ],
      safety,
      onStoredToolResult
    )

    for (const [index, item] of wrapped.entries()) {
      await (item as never as { execute: (id: string) => Promise<unknown> }).execute(`call-${index}`)
    }

    expect(detections.map((event) => event.toolCallId)).toEqual(['call-0', 'call-1'])
  })
})
