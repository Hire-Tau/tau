import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve, sep, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'

const origin = 'https://docs.hiretau.ai'
type Node = DefaultTreeAdapterMap['node']

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(path)))
    else files.push(path)
  }
  return files
}

function inspect(html: string) {
  const ids = new Set<string>()
  const links: string[] = []
  function visit(node: Node) {
    if ('attrs' in node) {
      for (const attr of node.attrs) {
        if (attr.name === 'id') ids.add(attr.value)
        // Check navigable links and resources, not canonical/alternate SEO metadata.
        const seoLink =
          node.tagName === 'link' &&
          node.attrs.some((a) => a.name === 'rel' && /(?:^|\s)(?:canonical|alternate)(?:\s|$)/.test(a.value))
        if (attr.name === 'src' || (attr.name === 'href' && !seoLink)) links.push(attr.value)
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit)
  }
  visit(parse(html))
  return { ids, links }
}

export async function checkLinks(directory: string, base = '/'): Promise<string[]> {
  const root = resolve(directory)
  const files = await filesUnder(root)
  const htmlFiles = files.filter((file) => file.endsWith('.html'))
  if (!htmlFiles.length) throw new Error('No built HTML found; run the docs build first.')
  const documents = new Map<string, ReturnType<typeof inspect>>()
  for (const file of htmlFiles) documents.set(file, inspect(await readFile(file, 'utf8')))
  const failures = new Set<string>()
  for (const [file, document] of documents) {
    const route = relative(root, file)
      .split(sep)
      .join('/')
      .replace(/index\.html$/, '')
    for (const link of document.links) {
      if (!link || /^(mailto:|tel:|data:|javascript:)/i.test(link)) continue
      let url: URL
      try {
        url = new URL(link, `${origin}${base}${route}`)
      } catch {
        failures.add(`${route}: invalid URL ${link}`)
        continue
      }
      if (url.origin !== origin) continue
      let path: string
      try {
        const pathname = decodeURIComponent(url.pathname)
        if (!pathname.startsWith(base)) {
          failures.add(`${route}: target escapes docs base ${link}`)
          continue
        }
        path = resolve(root, `./${pathname.slice(base.length)}`)
      } catch {
        failures.add(`${route}: invalid URL encoding ${link}`)
        continue
      }
      if (path !== root && !path.startsWith(root + sep)) {
        failures.add(`${route}: path outside site ${link}`)
        continue
      }
      const info = await stat(path).catch(() => null)
      if (info?.isDirectory()) path = resolve(path, 'index.html')
      if (!files.includes(path)) {
        failures.add(`${route}: missing target ${link}`)
        continue
      }
      if (url.hash && documents.has(path)) {
        let fragment: string
        try {
          fragment = decodeURIComponent(url.hash.slice(1))
        } catch {
          failures.add(`${route}: invalid fragment ${link}`)
          continue
        }
        // Text fragments target rendered text rather than an element ID.
        fragment = fragment.split(':~:text=')[0]
        if (fragment && !documents.get(path)!.ids.has(fragment)) failures.add(`${route}: missing anchor ${link}`)
      }
    }
  }
  return [...failures]
}

if (import.meta.main) {
  const embedded = process.argv.includes('--embedded')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), embedded ? '../../core/docs-dist' : '../dist')
  const failures = await checkLinks(root, embedded ? '/docs/' : '/')
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else console.log('Docs internal links, anchors, and linked assets passed.')
}
