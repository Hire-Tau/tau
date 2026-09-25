import { describe, expect, it } from 'bun:test'
import { MAX_SIGNING_PAYLOAD_BYTES, parseGitSigningPayload } from './signing-payload'

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

describe('parseGitSigningPayload', () => {
  it('reads the committer of a commit, not its author', () => {
    const commit = `tree ${TREE}\nparent ${TREE}\nauthor Someone <someone@example.com> 1 +0000\ncommitter Agent <Agent@Example.com> 2 -0500\n\nsubject\n\nbody mentioning committer x <y@z> 3 +0000\n`
    expect(parseGitSigningPayload(Buffer.from(commit))).toEqual({ kind: 'commit', signerEmail: 'agent@example.com' })
  })

  it('reads the tagger of an annotated tag', () => {
    const tag = `object ${TREE}\ntype commit\ntag v1\ntagger Agent <agent@example.com> 1 +0000\n\nrelease\n`
    expect(parseGitSigningPayload(Buffer.from(tag))).toEqual({ kind: 'tag', signerEmail: 'agent@example.com' })
  })

  it('accepts sha256 object ids', () => {
    const commit = `tree ${'a'.repeat(64)}\ncommitter Agent <agent@example.com> 1 +0000\n\nx\n`
    expect(parseGitSigningPayload(Buffer.from(commit)).kind).toBe('commit')
  })

  it('refuses anything that is not a commit or tag object', () => {
    for (const payload of [
      '',
      'hello world\n',
      'certificate version 0.1\npusher Agent <agent@example.com> 1 +0000\n\n',
      `tree not-a-hash\ncommitter Agent <agent@example.com> 1 +0000\n\nx\n`,
      `tree ${TREE}\nauthor Agent <agent@example.com> 1 +0000\n\nno committer\n`,
    ]) {
      expect(() => parseGitSigningPayload(Buffer.from(payload))).toThrow()
    }
    expect(() => parseGitSigningPayload(Buffer.alloc(MAX_SIGNING_PAYLOAD_BYTES + 1, 'a'))).toThrow()
  })
})
