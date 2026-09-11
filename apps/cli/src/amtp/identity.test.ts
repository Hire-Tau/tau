import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { generateKeyPairSync, verify } from 'crypto'
import {
  readIdentityPrivateKeyPem,
  signAgentSig,
  deriveAgentKeyPem,
  writeIdentityCache,
  readIdentityCache,
  identityPemPath,
  identityCachePath,
  requireMatchingSigningIdentity,
} from './identity'

let dir: string
let priv: string
let pub: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fed-id-'))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  priv = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  pub = publicKey.export({ type: 'spki', format: 'pem' }) as string
  process.env.TAU_IDENTITY_PEM = join(dir, 'identity.pem')
  process.env.TAU_IDENTITY_CACHE = join(dir, 'identity.json')
})

afterEach(async () => {
  delete process.env.TAU_IDENTITY_PEM
  delete process.env.TAU_IDENTITY_CACHE
  delete process.env.TAU_PRIVATE_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('readIdentityPrivateKeyPem', () => {
  test('throws a retry-after-provisioning error when the key is missing', () => {
    expect(() => readIdentityPrivateKeyPem()).toThrow(/Retry after the sandbox finishes provisioning/)
  })
  test('returns the PEM when present', async () => {
    await writeFile(process.env.TAU_IDENTITY_PEM!, priv)
    expect(readIdentityPrivateKeyPem()).toBe(priv)
  })
})

describe('signAgentSig + deriveAgentKeyPem', () => {
  test('signature verifies under the derived public key', () => {
    const bytes = new TextEncoder().encode('hello-federation')
    const sigB64 = signAgentSig(priv, bytes)
    expect(verify(null, bytes, deriveAgentKeyPem(priv), Buffer.from(sigB64, 'base64'))).toBe(true)
  })
  test('derived agentKey equals the SPKI public export the server stores', () => {
    expect(deriveAgentKeyPem(priv)).toBe(pub)
  })
})

describe('identity cache', () => {
  test('round-trips the cached identity', () => {
    expect(readIdentityCache()).toBeNull()
    writeIdentityCache({ handle: 'alice', address: 'amtp://inst/alice', identityPublicKey: pub })
    expect(readIdentityCache()).toEqual({ handle: 'alice', address: 'amtp://inst/alice', identityPublicKey: pub })
  })
})

describe('portable identity paths', () => {
  test('uses the delivered private-root key path', () => {
    delete process.env.TAU_IDENTITY_PEM
    delete process.env.TAU_IDENTITY_CACHE
    process.env.TAU_PRIVATE_DIR = '/sandbox-private'
    expect(identityPemPath()).toBe('/sandbox-private/identity.pem')
    expect(identityCachePath()).toBe('/sandbox-private/.tau/identity.json')
  })
})

describe('requireMatchingSigningIdentity', () => {
  test('returns matching delivered key material', async () => {
    await writeFile(process.env.TAU_IDENTITY_PEM!, priv)
    expect(requireMatchingSigningIdentity(pub)).toEqual({ privateKeyPem: priv, publicKeyPem: pub })
  })
  test('rejects a public/private mismatch without rotating', async () => {
    await writeFile(process.env.TAU_IDENTITY_PEM!, priv)
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string
    expect(() => requireMatchingSigningIdentity(other)).toThrow(/does not match.*automatic rotation is disabled/i)
  })
})

describe('identity path expansion', () => {
  const originals = {
    dir: process.env.TAU_PRIVATE_DIR,
    pem: process.env.TAU_IDENTITY_PEM,
    cache: process.env.TAU_IDENTITY_CACHE,
  }

  afterEach(() => {
    for (const [key, value] of [
      ['TAU_PRIVATE_DIR', originals.dir],
      ['TAU_IDENTITY_PEM', originals.pem],
      ['TAU_IDENTITY_CACHE', originals.cache],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('expands a leading ~ in TAU_IDENTITY_PEM', () => {
    process.env.TAU_IDENTITY_PEM = '~/.private/identity.pem'
    expect(identityPemPath()).toBe(join(homedir(), '.private/identity.pem'))
  })

  test('expands a leading ~ in TAU_IDENTITY_CACHE', () => {
    process.env.TAU_IDENTITY_CACHE = '~/.private/identity.json'
    expect(identityCachePath()).toBe(join(homedir(), '.private/identity.json'))
  })

  test('expands a leading ~ in TAU_PRIVATE_DIR, which the other two derive from', () => {
    delete process.env.TAU_IDENTITY_PEM
    delete process.env.TAU_IDENTITY_CACHE
    process.env.TAU_PRIVATE_DIR = '~/agent-private'
    expect(identityPemPath()).toBe(join(homedir(), 'agent-private/identity.pem'))
    expect(identityCachePath()).toBe(join(homedir(), 'agent-private/.tau/identity.json'))
  })
})
