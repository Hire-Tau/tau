import type { ToolRenderer, ToolRenderers } from '../lib/tool-renderers'

function JsonDetails({ value }: { value: string }) {
  let text = value
  try {
    text = JSON.stringify(JSON.parse(value.replace(/^API error: \d+:\s*/, '')), null, 2)
  } catch {
    // Keep complete non-JSON details for inspection.
  }
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-code-bg p-2 text-[11px] text-code-text">
      {text}
    </pre>
  )
}
const draftTool: ToolRenderer = {
  summary: (args) => (typeof args.summary === 'string' ? args.summary : ''),
  ArgsView: ({ args }) => <JsonDetails value={JSON.stringify(args)} />,
  ResultView: ({ result }) => {
    let detail = result
    try {
      const parsed = JSON.parse(result)
      if (typeof parsed?.error === 'string') detail = parsed.error
    } catch {
      /* Plain tool output. */
    }
    return <JsonDetails value={detail} />
  },
}

export const pageEditorToolRenderers: ToolRenderers = {
  read: draftTool,
  edit: draftTool,
  delegate: draftTool,
}
