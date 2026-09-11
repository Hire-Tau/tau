export interface OutputOptions {
  json?: boolean
  quiet?: boolean
}

let globalOptions: OutputOptions = {}

export function setOutputOptions(options: OutputOptions) {
  globalOptions = options
}

export function output(data: unknown, message?: string) {
  if (globalOptions.json) {
    console.log(JSON.stringify(data, null, 2))
  } else if (!globalOptions.quiet) {
    if (message) console.log(message)
    else console.log(data)
  }
}

const COLUMN_PADDING = 2

function displayWidth(s: string): number {
  // Tabs and control chars can misalign; treat tab as 8 for width calc
  let w = 0
  for (const c of s) {
    w += c === '\t' ? 8 : c >= '\u0020' && c !== '\u007f' ? 1 : 0
  }
  return w
}

export function outputTable(items: any[], columns: string[]) {
  if (globalOptions.json) {
    console.log(JSON.stringify(items, null, 2))
    return
  }
  if (globalOptions.quiet || items.length === 0) return

  const widths = columns.map((col) => {
    const headerW = displayWidth(col)
    const maxDataW = Math.max(0, ...items.map((item) => displayWidth(String(item[col] ?? ''))))
    return Math.max(headerW, maxDataW, 1)
  })

  const pad = (s: string, w: number) => {
    const len = displayWidth(s)
    return len >= w ? s : s + ' '.repeat(w - len)
  }
  const sep = widths.map((w) => '-'.repeat(w)).join(' '.repeat(COLUMN_PADDING))

  console.log(columns.map((c, i) => pad(c, widths[i])).join(' '.repeat(COLUMN_PADDING)))
  console.log(sep)
  for (const item of items) {
    console.log(columns.map((c, i) => pad(String(item[c] ?? ''), widths[i])).join(' '.repeat(COLUMN_PADDING)))
  }
}

export function isJsonMode(): boolean {
  return !!globalOptions.json
}

export function isQuietMode(): boolean {
  return !!globalOptions.quiet
}

export function outputError(error: Error, exitCode = 1) {
  if (globalOptions.json) {
    console.error(JSON.stringify({ error: error.message }))
  } else {
    console.error(`Error: ${error.message}`)
  }
  process.exit(exitCode)
}
