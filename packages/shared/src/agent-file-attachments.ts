/** The single directory name chat attachments are materialised into, inside
 *  whatever the runtime uses as the agent's private area. */
export const AGENT_ATTACHMENT_DIRECTORY = 'chat-attachments'

/**
 * The attachment root of the CONTAINER runtimes (k8s + docker), whose private
 * area is always mounted at the literal `/private`. It is NOT the root on the
 * other runtimes — host materialises under `<HOME_DIR>/private/<sandboxId>`,
 * vm under the box's `~/.private` — so it survives only as the provisional
 * client-side default of {@link buildAgentAttachmentPath}, used before the
 * upload response reveals the real path.
 *
 * References already recorded with this root still EXTRACT and still link to
 * their row (the row stores the same string), but they only name a file that
 * exists where the mount does: on host such a legacy reference points at a
 * `/private` that is not there, and the agent cannot open it.
 */
export const AGENT_ATTACHMENT_ROOT = `/private/${AGENT_ATTACHMENT_DIRECTORY}`

/** The agent-visible attachment root for a runtime's private mount. */
export function agentAttachmentRoot(privateMount: string): string {
  return `${privateMount.replace(/\/+$/, '')}/${AGENT_ATTACHMENT_DIRECTORY}`
}

// Hex is spelled with both cases rather than with the regex `i` flag: matching
// is otherwise case-insensitive for the ROOT too, and an extracted path is
// compared verbatim with the row's stored private_path, so `/PRIVATE/...` would
// extract and then fail that comparison instead of staying inert.
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
// An absolute, bounded prefix: the private mount the attachment root hangs off
// (`/private`, `/home/<box>/.private`, `<HOME_DIR>/private/<sandboxId>`, ...).
// A segment is anything but a separator, whitespace, `@` or a quote — a home
// directory may legitimately contain non-ASCII (`/Users/José/...`), while the
// excluded characters are the ones that would make the `@token` unparseable.
const ROOT_PREFIX_PATTERN = '(?:/[^/\\s@"]{1,64}){0,24}'
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i')
const MAX_STORED_NAME_LENGTH = 120
const MAX_EXTENSION_LENGTH = 16

export interface AgentAttachmentReference {
  id: string
  path: string
  name: string
  start: number
  end: number
}

/** Convert an untrusted display name to the single safe path component used for chat files. */
export function sanitizeAgentAttachmentName(originalName: string): string {
  const basename = originalName.split(/[\\/]/).at(-1) ?? ''
  const withoutControls = Array.from(basename.normalize('NFC'))
    .filter((character) => {
      const code = character.codePointAt(0)!
      return code > 31 && (code < 127 || code > 159)
    })
    .join('')
  const normalized = withoutControls
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '')

  if (!normalized || normalized === '.' || normalized === '..') return 'attachment'
  if (normalized.length <= MAX_STORED_NAME_LENGTH) return normalized

  const extensionMatch = normalized.match(/(\.[A-Za-z0-9]{1,16})$/)
  const extension = extensionMatch?.[1] ?? ''
  const stemLength = MAX_STORED_NAME_LENGTH - extension.length
  return `${normalized.slice(0, stemLength)}${extension.slice(0, MAX_EXTENSION_LENGTH + 1)}`
}

/**
 * Build an agent-visible path without accepting any caller-controlled
 * directory. `root` must come from {@link agentAttachmentRoot} applied to the
 * ACTIVE runtime's private mount; it defaults to the container root so callers
 * that genuinely mean `/private` (and tests) stay unchanged.
 */
export function buildAgentAttachmentPath(
  id: string,
  originalName: string,
  root: string = AGENT_ATTACHMENT_ROOT
): string {
  if (!UUID_RE.test(id)) throw new Error('Invalid attachment id')
  return `${root}/${id.toLowerCase()}/${sanitizeAgentAttachmentName(originalName)}`
}

/**
 * Whether an agent-visible attachment path survives the round trip through the
 * reference syntax: `@<path>` must extract back to exactly this path. A private
 * mount containing a space, a quote or an `@` cannot be expressed as a token,
 * so a reference to it would never link back to its row — callers must refuse
 * such an upload rather than store a path nothing can name.
 */
export function isReferencableAgentAttachmentPath(path: string): boolean {
  const references = extractAgentAttachmentReferences(`@${path}`)
  return references.length === 1 && references[0].path === path
}

/**
 * Extract only canonical generated attachment references, retaining exact
 * source spans.
 *
 * The root is NOT pinned to `/private`: the same message text may name a host
 * (`<HOME_DIR>/private/<sandboxId>/...`) or vm (`~/.private/...`) path, and a
 * reader must resolve historical `/private` references too. Extraction is
 * therefore shape-based; authority stays with the caller, which compares the
 * extracted path against the attachment row's stored `private_path` before it
 * grants access (see assertReadyAttachmentReference in core).
 */
export function extractAgentAttachmentReferences(text: string): AgentAttachmentReference[] {
  const pattern = new RegExp(
    `@(${ROOT_PREFIX_PATTERN}/${AGENT_ATTACHMENT_DIRECTORY})/(${UUID_PATTERN})/([A-Za-z0-9_-][A-Za-z0-9._-]{0,119})`,
    'g'
  )
  const references: AgentAttachmentReference[] = []

  for (const match of text.matchAll(pattern)) {
    const start = match.index
    const root = match[1]
    const id = match[2].toLowerCase()
    const name = match[3].replace(/\.+$/, '')
    if (!name) continue
    const end = start + match[0].length - (match[3].length - name.length)
    const continuation = text.slice(end)
    if (/^(?:\/|#|%|\?[A-Za-z0-9_=&%-]|[A-Za-z0-9_-])/.test(continuation)) continue
    const path = `${root}/${id}/${name}`
    references.push({ id, path, name, start, end })
  }

  return references
}
