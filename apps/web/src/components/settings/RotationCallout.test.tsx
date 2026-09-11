import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RotationCallout } from './RotationCallout'
import type { RevokeRotationResult } from '../../api/remote-hosts'

describe('RotationCallout', () => {
  test('rotated: shows the new public key + install guidance', () => {
    const result: RevokeRotationResult = {
      revoked: true,
      rotated: true,
      sshPublicKey: 'ssh-ed25519 AAAANEWKEY',
      message: 'Host key rotated. Append this public key to ~/.ssh/authorized_keys on the host.',
    }
    const html = renderToStaticMarkup(<RotationCallout result={result} />)
    expect(html).toContain('ssh-ed25519 AAAANEWKEY')
    expect(html).toContain('authorized_keys')
  })

  test('rotation failed: shows the warning, not a public key', () => {
    const result: RevokeRotationResult = {
      revoked: true,
      rotated: false,
      warning: 'Grant revoked, but rotating the host key failed — the previous key remains valid until you retry.',
    }
    const html = renderToStaticMarkup(<RotationCallout result={result} />)
    expect(html).toContain('previous key remains valid')
    expect(html).not.toContain('ssh-ed25519')
  })

  test('no-op rotation (already-deleted host): shows the distinguishing message', () => {
    const result: RevokeRotationResult = {
      revoked: true,
      rotated: false,
      message: 'Host already deleted; nothing to rotate.',
    }
    const html = renderToStaticMarkup(<RotationCallout result={result} />)
    expect(html).toContain('Host already deleted')
    expect(html).not.toContain('ssh-ed25519')
  })
})
