import { PublicKeyBlock } from './PublicKeyBlock'
import type { RevokeRotationResult } from '../../api/remote-hosts'

/**
 * Post-revoke callout. Every revoke rotates the host's minted keypair, so the
 * operator must install the new public key on the host. Reuses the
 * registration-time PublicKeyBlock pattern:
 *  - `rotated:true` → the new pubkey + "update authorized_keys" guidance.
 *  - `rotated:false` → a warning (rotation failed — retry) or the no-op message
 *    (nothing to rotate, e.g. the host was already deleted).
 */
export function RotationCallout({ result }: { result: RevokeRotationResult }) {
  if (result.rotated && result.sshPublicKey) {
    return (
      <div className="border-b border-panel-border last:border-b-0 p-3 space-y-2">
        <p className="text-xs text-primary font-medium">
          {result.message ??
            'Host key rotated. Update ~/.ssh/authorized_keys on the host with the new public key below.'}
        </p>
        <PublicKeyBlock label="New SSH public key" value={result.sshPublicKey} />
      </div>
    )
  }

  return (
    <div className="rounded border border-status-attention-300 dark:border-status-attention-800 bg-status-attention-50 dark:bg-status-attention-900/20 p-3">
      <p className="text-xs text-status-attention-700 dark:text-status-attention-400">
        {result.warning ?? result.message ?? 'Grant revoked.'}
      </p>
    </div>
  )
}
