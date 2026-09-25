/**
 * What Core agrees to sign: a git commit or tag object as git hands it to
 * `gpg.ssh.program` (the object text without its signature header). Anything
 * else (push certificates, arbitrary files) is refused, and the payload names
 * the identity the signature would vouch for.
 */

export const MAX_SIGNING_PAYLOAD_BYTES = 1024 * 1024

export interface GitSigningPayload {
  kind: 'commit' | 'tag'
  /** Committer email for commits, tagger email for tags; lower-cased. */
  signerEmail: string
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const IDENT = /^.* <([^<>\s]+)> \d+ [+-]\d{4}$/

export function parseGitSigningPayload(data: Buffer): GitSigningPayload {
  if (data.length === 0 || data.length > MAX_SIGNING_PAYLOAD_BYTES) throw new Error('not a git object')
  const text = data.toString('utf8')
  const headerEnd = text.indexOf('\n\n')
  const header = (headerEnd === -1 ? text : text.slice(0, headerEnd)).split('\n')
  const [firstField, firstValue] = splitField(header[0] ?? '')
  const kind = firstField === 'tree' ? 'commit' : firstField === 'object' ? 'tag' : undefined
  if (!kind || !OBJECT_ID.test(firstValue)) throw new Error('not a git object')
  const identityField = kind === 'commit' ? 'committer' : 'tagger'
  const identity = header.map(splitField).find(([field]) => field === identityField)?.[1]
  const email = identity ? IDENT.exec(identity)?.[1] : undefined
  if (!email) throw new Error(`git ${kind} has no ${identityField}`)
  return { kind, signerEmail: email.toLowerCase() }
}

function splitField(line: string): [string, string] {
  const space = line.indexOf(' ')
  return space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)]
}
