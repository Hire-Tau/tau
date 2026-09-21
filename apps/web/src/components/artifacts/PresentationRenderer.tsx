import { useThemeColors } from '../../theme/useThemeColors'
import { chartThemeConfig } from '../../theme/chart'
import type {
  CalloutBlock,
  ChartBlock,
  HtmlBlock,
  MetricsBlock,
  Presentation,
  PresentationBlock,
  PresentationTone,
  TableBlock,
  TimelineBlock,
} from '@tau/shared'
import clsx from 'clsx'
import { Component, useEffect, useId, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import type { VegaEmbedProps } from 'react-vega'
import { VegaEmbed } from 'react-vega'
import { loader as createVegaLoader, type Loader } from 'vega'
import { MarkdownContent } from '../MarkdownContent'
import {
  clampHtmlBlockHeight,
  getPresentationHtmlHeightMessageType,
  isPresentationHtmlHeightMessage,
} from './PresentationHtmlBlockSizing'

export function PresentationRenderer({
  presentation,
  chrome = 'default',
}: {
  presentation: Presentation
  chrome?: 'default' | 'none'
}) {
  return (
    <article className={clsx(chrome === 'default' && 'space-y-6 p-5') || undefined}>
      {chrome === 'default' && (
        <header>
          <h1 className="text-2xl font-semibold text-gray-950 dark:text-gray-50">{presentation.title}</h1>
        </header>
      )}
      <div className={clsx(chrome === 'default' && 'space-y-5') || undefined}>
        {presentation.sections.map((section) => (
          <section
            key={section.id}
            className={
              clsx(
                chrome === 'default' &&
                  'space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900'
              ) || undefined
            }
          >
            {chrome === 'default' && section.title && (
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{section.title}</h2>
            )}
            <div className={clsx(chrome === 'default' && 'space-y-4') || undefined}>
              {section.blocks.map((block, index) => (
                <PresentationBlockRenderer key={`${section.id}-${block.type}-${index}`} block={block} chrome={chrome} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  )
}

function PresentationBlockRenderer({ block, chrome }: { block: PresentationBlock; chrome: 'default' | 'none' }) {
  switch (block.type) {
    case 'markdown':
      return looksLikeHtmlBlock(block.content) ? (
        <HtmlBlockView block={{ type: 'html', content: htmlFromLegacyMarkdownHtml(block.content) }} chrome={chrome} />
      ) : (
        <MarkdownContent>{block.content}</MarkdownContent>
      )
    case 'html':
      return <HtmlBlockView block={block} chrome={chrome} />
    case 'metrics':
      return <MetricsBlockView block={block} />
    case 'table':
      return <TableBlockView block={block} />
    case 'chart':
      return <ChartBlockView block={block} />
    case 'callout':
      return <CalloutBlockView block={block} />
    case 'timeline':
      return <TimelineBlockView block={block} />
    default:
      return null
  }
}

function MetricsBlockView({ block }: { block: MetricsBlock }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {block.items.map((item) => (
        <div key={item.label} className={clsx('rounded-lg border p-4', toneClasses(item.tone, 'card'))}>
          <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">{item.label}</dt>
          <dd className="mt-2 text-2xl font-semibold text-gray-950 dark:text-gray-50">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function TableBlockView({ block }: { block: TableBlock }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="tau-table min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
        <thead className="bg-gray-50 dark:bg-gray-900">
          <tr>
            {block.columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="px-3 py-2 text-left font-semibold text-gray-700 dark:text-gray-200"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-950">
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {block.columns.map((column) => (
                <td key={column.key} className="px-3 py-2 text-gray-700 dark:text-gray-300">
                  {formatCellValue(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChartBlockView({ block }: { block: ChartBlock }) {
  const colors = useThemeColors()
  const config = useMemo(() => chartThemeConfig(block.spec, colors), [block.spec, colors])
  const [renderError, setRenderError] = useState<string | null>(null)

  if (hasExternalUrlReference(block.spec)) {
    return (
      <BlockError
        title="Unable to render chart"
        detail="Chart specs with external URLs are blocked for artifact safety. Use inline data values instead."
      />
    )
  }

  if (renderError) {
    return <BlockError title="Unable to render chart" detail={renderError} />
  }

  return (
    <ChartErrorBoundary>
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
        <VegaEmbed
          spec={block.spec as VegaEmbedProps['spec']}
          options={{ actions: false, renderer: 'canvas', loader: blockingVegaLoader, config }}
          onError={(error) =>
            setRenderError(error instanceof Error ? error.message : 'The chart spec could not be rendered.')
          }
          className="w-full"
        />
      </div>
    </ChartErrorBoundary>
  )
}

class ChartErrorBoundary extends Component<{ children: ReactNode }, { errorMessage: string | null }> {
  override state = { errorMessage: null }

  static getDerivedStateFromError(error: unknown) {
    return { errorMessage: error instanceof Error ? error.message : 'The chart spec could not be rendered.' }
  }

  override componentDidCatch(_error: Error, _errorInfo: ErrorInfo) {
    // React still reports render/mount failures to the console in development, but
    // the boundary keeps malformed chart specs from crashing the artifact panel.
  }

  override render() {
    if (this.state.errorMessage) {
      return <BlockError title="Unable to render chart" detail={this.state.errorMessage} />
    }

    return this.props.children
  }
}

function CalloutBlockView({ block }: { block: CalloutBlock }) {
  return (
    <aside className={clsx('rounded-lg border p-4', toneClasses(block.tone, 'callout'))}>
      {block.title && <p className="font-semibold">{block.title}</p>}
      <div className={clsx(block.title && 'mt-2')}>
        <MarkdownContent>{block.content}</MarkdownContent>
      </div>
    </aside>
  )
}

function TimelineBlockView({ block }: { block: TimelineBlock }) {
  return (
    <ol className="space-y-3 border-l border-gray-200 pl-4 dark:border-gray-800">
      {block.items.map((item, index) => (
        <li key={`${item.title}-${item.at ?? index}`} className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[21px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-blue-500 dark:border-gray-900"
          />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{item.title}</h3>
            {item.at && (
              <time className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{item.at}</time>
            )}
          </div>
          {item.content && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{item.content}</p>}
        </li>
      ))}
    </ol>
  )
}

const PRESENTATION_HTML_BLOCK_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; object-src 'none'; connect-src * http: https: ws: wss:; script-src 'unsafe-inline'"
const PRESENTATION_HTML_CONTENT_ID = 'tau-presentation-html-content'

const VOICE_HOLD_SHORTCUT_BRIDGE_SCRIPT = `
<script>
(() => {
  const isEditableTarget = (target) => {
    const tagName = target?.tagName?.toUpperCase?.()
    return Boolean(target?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON')
  }
  const isSpace = (event) => event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar'
  window.addEventListener('keydown', (event) => {
    if (!isSpace(event) || event.repeat || isEditableTarget(event.target)) return
    event.preventDefault()
    window.parent?.postMessage({ type: 'tau:voice-hold-keydown', repeat: event.repeat }, '*')
  }, { capture: true })
  window.addEventListener('keyup', (event) => {
    if (!isSpace(event) || isEditableTarget(event.target)) return
    event.preventDefault()
    window.parent?.postMessage({ type: 'tau:voice-hold-keyup' }, '*')
  }, { capture: true })
})()
</script>`

function HtmlBlockView({ block, chrome }: { block: HtmlBlock; chrome: 'default' | 'none' }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const reactId = useId()
  const blockId = `presentation-html-${reactId}`
  const minHeight = block.minHeight ?? (chrome === 'none' ? 120 : 360)
  const maxHeight = block.maxHeight ?? 4000
  const fixedHeight = block.height
  const [autoHeight, setAutoHeight] = useState(minHeight)
  const height = fixedHeight ?? autoHeight
  const autoHeightEnabled = fixedHeight === undefined
  const srcDoc = useMemo(
    () => withPresentationHtmlBlockShell(block.content, blockId, autoHeightEnabled),
    [autoHeightEnabled, block.content, blockId]
  )

  useEffect(() => {
    if (!autoHeightEnabled) return

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (!isPresentationHtmlHeightMessage(event.data, blockId)) return

      const nextHeight = clampHtmlBlockHeight(event.data.height, minHeight, maxHeight)
      setAutoHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight))
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [autoHeightEnabled, blockId, maxHeight, minHeight])

  return (
    <iframe
      ref={iframeRef}
      title={block.iframeAccessibilityTitle ?? 'Presentation HTML block'}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ height }}
      className={clsx(
        'w-full bg-white',
        chrome === 'none' ? 'border-0' : 'rounded-lg border border-gray-200 dark:border-gray-800'
      )}
    />
  )
}

function withPresentationHtmlBlockShell(content: string, blockId: string, autoHeightEnabled: boolean): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PRESENTATION_HTML_BLOCK_CSP}"><style>html,body{margin:0;overflow:hidden;}#${PRESENTATION_HTML_CONTENT_ID}{display:flow-root;}</style>${VOICE_HOLD_SHORTCUT_BRIDGE_SCRIPT}</head><body><div id="${PRESENTATION_HTML_CONTENT_ID}">${content}</div>${
    autoHeightEnabled ? presentationHtmlHeightScript(blockId) : ''
  }</body></html>`
}

function presentationHtmlHeightScript(blockId: string): string {
  return `<script>(()=>{const blockId=${JSON.stringify(blockId)};const type=${JSON.stringify(
    getPresentationHtmlHeightMessageType()
  )};const contentId=${JSON.stringify(PRESENTATION_HTML_CONTENT_ID)};let lastHeight=0;const clamp=(value)=>Math.max(120,Math.min(4000,Math.ceil(value)));const margin=(styles,name)=>Number.parseFloat(styles.getPropertyValue(name))||0;const measure=()=>{const content=document.getElementById(contentId);if(!content)return;const styles=getComputedStyle(content);const rect=content.getBoundingClientRect();const height=clamp(Math.max(content.scrollHeight,rect.height)+margin(styles,'margin-top')+margin(styles,'margin-bottom'));if(height===lastHeight)return;lastHeight=height;parent.postMessage({type,blockId,height},'*')};const observe=(target)=>{if(!target||typeof ResizeObserver==='undefined')return;new ResizeObserver(measure).observe(target)};observe(document.getElementById(contentId));addEventListener('load',measure);addEventListener('resize',measure);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(measure).catch(()=>{});if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',measure,{once:true})}requestAnimationFrame(measure)})()</script>`
}

function looksLikeHtmlBlock(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content) && /\sstyle\s*=|<html[\s>]|<body[\s>]|<!doctype\s+html/i.test(content)
}

function htmlFromLegacyMarkdownHtml(content: string): string {
  const firstTagIndex = content.search(/<[a-z!]/i)
  if (firstTagIndex === -1) return content
  return content.slice(firstTagIndex).trim()
}

function BlockError({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{detail}</p>
    </div>
  )
}

function formatCellValue(value: unknown) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function hasExternalUrlReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExternalUrlReference)
  if (!value || typeof value !== 'object') return false

  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.toLowerCase()
    if (
      normalizedKey !== '$schema' &&
      (normalizedKey === 'url' || normalizedKey === 'href' || normalizedKey === 'src')
    ) {
      return typeof child === 'string' || hasExternalUrlReference(child)
    }
    return hasExternalUrlReference(child)
  })
}

const baseVegaLoader = createVegaLoader()
const blockingVegaLoader: Loader = {
  ...baseVegaLoader,
  load(uri, options) {
    if (isBlockedUri(uri)) return Promise.reject(new Error('External chart resources are blocked.'))
    return baseVegaLoader.load(uri, options)
  },
  sanitize(uri, options) {
    if (isBlockedUri(uri)) return Promise.reject(new Error('External chart links are blocked.'))
    return baseVegaLoader.sanitize(uri, options)
  },
  http(uri) {
    return Promise.reject(new Error(`External chart resource blocked: ${uri}`))
  },
}

function isBlockedUri(uri: string) {
  return !uri.startsWith('data:')
}

function toneClasses(tone: PresentationTone | undefined, variant: 'card' | 'callout') {
  const base =
    variant === 'card' ? 'bg-white dark:bg-gray-950' : 'bg-gray-50 text-gray-800 dark:bg-gray-900 dark:text-gray-200'

  switch (tone) {
    case 'info':
      return 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100'
    case 'success':
      return 'border-green-200 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/40 dark:text-green-100'
    case 'warning':
      return 'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-900/60 dark:bg-yellow-950/40 dark:text-yellow-100'
    case 'error':
      return 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100'
    case 'neutral':
    default:
      return clsx('border-gray-200 dark:border-gray-800', base)
  }
}
