import { getWorkStreamLink } from './inboxWorkStreamLink'

/**
 * Resolve where a push notification opens. Exact Action Center targets win; otherwise the
 * server-built `url` is honored only when it stays on this origin (base path included), so a
 * saved Assistant conversation link (`/?chat=open&assistantConversation=…`) is preserved and an
 * unexpected external destination falls back to the app root.
 */
export function resolveNotificationTarget(data: Record<string, unknown>, origin: string, basePath: string): string {
  const prefix = (path: string) => basePath.replace(/\/$/, '') + path
  const exactActionPath = getWorkStreamLink(data)
  if (exactActionPath) return prefix(exactActionPath)
  const url = typeof data.url === 'string' ? data.url : ''
  if (!url) return prefix('/')
  try {
    const parsed = new URL(url, origin)
    if (parsed.origin !== origin) return prefix('/')
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return prefix('/')
  }
}
