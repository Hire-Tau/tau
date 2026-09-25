import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'crypto'

/**
 * OpenSSH "SSHSIG" signatures (PROTOCOL.sshsig) over ed25519, byte-compatible
 * with `ssh-keygen -Y sign`. Core signs agents' git commits with a key it never
 * hands to a sandbox, so it produces the armored signature git expects from
 * `gpg.ssh.program` itself instead of shelling out.
 */

const MAGIC = Buffer.from('SSHSIG')
const KEY_TYPE = 'ssh-ed25519'
const HASH = 'sha512'

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

function publicKeyBlob(rawPublicKey: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(rawPublicKey)])
}

export interface SshSigningKey {
  /** PKCS#8 PEM; stays in Core's secret store. */
  privateKey: string
  /** OpenSSH authorized_keys form: `ssh-ed25519 AAAA… comment`. */
  publicKey: string
}

export function generateSshSigningKey(comment: string): SshSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  // The SPKI DER of an ed25519 key ends with the 32 raw key bytes.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: `${KEY_TYPE} ${publicKeyBlob(raw).toString('base64')} ${comment}`.trim(),
  }
}

/** The public half, derived from the private key rather than trusting a stored copy. */
function rawPublicKey(privateKeyPem: string): Buffer {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing key is not ed25519')
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
}

/** `ssh-keygen -l` style fingerprint: `SHA256:<unpadded base64>`. */
export function sshKeyFingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1] ?? '', 'base64')
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** Armored SSHSIG over `data`, exactly what `ssh-keygen -Y sign -n <namespace>` writes to `<file>.sig`. */
export function signSshSig(privateKeyPem: string, data: Buffer, namespace = 'git'): string {
  const pub = publicKeyBlob(rawPublicKey(privateKeyPem))
  const digest = createHash(HASH).update(data).digest()
  const signedData = Buffer.concat([MAGIC, sshString(namespace), sshString(''), sshString(HASH), sshString(digest)])
  const signature = sign(null, signedData, createPrivateKey(privateKeyPem))
  const version = Buffer.alloc(4)
  version.writeUInt32BE(1)
  const blob = Buffer.concat([
    MAGIC,
    version,
    sshString(pub),
    sshString(namespace),
    sshString(''),
    sshString(HASH),
    sshString(Buffer.concat([sshString(KEY_TYPE), sshString(signature)])),
  ])
  const body = blob
    .toString('base64')
    .match(/.{1,70}/g)!
    .join('\n')
  return `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`
}
