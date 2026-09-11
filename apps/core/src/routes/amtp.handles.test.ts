import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { signAgentCard, canonicalPeerGetString } from 'amtp-protocol'
import type { AmtpSignedAgentCard } from 'amtp-protocol'
import { db, agents } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import { amtpRouter } from './amtp'
import { InstanceIdentity } from '../entities/InstanceIdentity'
import { Peer } from '../entities/Peer'
import { Agent } from '../entities/Agent'
import { agentIdentityHostPath, ensureAgentIdentity } from '../services/amtp/agent-identity'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope } from '../services/amtp/crypto'

// Production-like app: identity bypass + sentinel wired exactly as in index.ts.
const app = new Hono()
app.use('/api/*', identityMiddleware)
app.use('/api/*', authzSentinel)
app.route('/api/amtp', amtpRouter)

const prefix = `fed-handles-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const peerKeys = generateInstanceKeyPair()
const peerInstanceId = instanceIdFromPublicKeyPem(peerKeys.publicKeyPem)
let peer: Peer
const agentIds: string[] = []

const PATH = '/api/amtp/handles'

function signedHeaders(ts = Date.now()): Record<string, string> {
  const signature = signEnvelope(
    peerKeys.privateKeyPem,
    new TextEncoder().encode(canonicalPeerGetString('GET', PATH, ts))
  )
  return { 'x-amtp-instance': peerInstanceId, 'x-amtp-signature': signature, 'x-amtp-timestamp': String(ts) }
}

beforeAll(async () => {
  peer = await Peer.create({
    localAlias: `${prefix}-peer`,
    instanceId: peerInstanceId,
    baseUrl: 'https://peer.example/api',
    publicKeyPem: peerKeys.publicKeyPem,
  })
  // Registered live agents (b before a to prove sorting), one terminated, one handle-less.
  for (const row of [
    { handle: `${prefix}-bbb`, terminated: false, keyless: false, invalid: false },
    { handle: `${prefix}-aaa`, terminated: false, keyless: false, invalid: false },
    { handle: `${prefix}-terminated`, terminated: true, keyless: false, invalid: false },
    { handle: `${prefix}-keyless`, terminated: false, keyless: true, invalid: false },
    { handle: `${prefix}-invalid`, terminated: false, keyless: false, invalid: true },
    { handle: null, terminated: false, keyless: false, invalid: false },
  ]) {
    const id = crypto.randomUUID()
    agentIds.push(id)
    await db.insert(agents).values({
      id,
      agentTypeId: 'manager',
      squadId: null,
      status: 'idle',
      amtpHandle: row.handle,
      terminatedAt: null,
    })
    if (!row.keyless && !row.invalid) await ensureAgentIdentity(await Agent.mustFind(id), `agent_${id}`)
    if (row.terminated) {
      await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, id))
    }
    if (row.invalid) await db.update(agents).set({ identityPublicKey: 'invalid-public-key' }).where(eq(agents.id, id))
    if (row.handle === `${prefix}-bbb`) rmSync(agentIdentityHostPath(`agent_${id}`), { force: true })
  }
})

afterAll(async () => {
  for (const id of agentIds) {
    rmSync(dirname(dirname(agentIdentityHostPath(`agent_${id}`))), { recursive: true, force: true })
    await db.delete(agents).where(eq(agents.id, id))
  }
  await Peer.delete(peer.id)
})

describe('GET /api/amtp/handles', () => {
  test('unsigned request → 401', async () => {
    const res = await app.request(PATH)
    expect(res.status).toBe(401)
  })

  test('signed request → 200 with sorted live registered handles only', async () => {
    const res = await app.request(PATH, { headers: signedHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { handles: { handle: string }[] }
    const mine = body.handles.filter((h) => h.handle.startsWith(prefix))
    // Durable public identities remain listed even without a private PEM; null/invalid-key, terminated, and handle-less agents are excluded.
    expect(mine.map((h) => h.handle)).toEqual([`${prefix}-aaa`, `${prefix}-bbb`])
  })

  test('stale timestamp → 401', async () => {
    const res = await app.request(PATH, { headers: signedHeaders(Date.now() - 10 * 60 * 1000) })
    expect(res.status).toBe(401)
  })
})

// Own describe block (own agent fixtures, own prefix) so this suite's exact-equality
// assertion above ("sorted live registered handles only") is never affected by the extra
// agents seeded here.
describe('GET /api/amtp/handles — card-derived hints', () => {
  const hintPrefix = `fed-handles-hint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const hintAgentIds: string[] = []
  const cardHandle = `${hintPrefix}-carded`
  const bareHandle = `${hintPrefix}-bare`

  beforeAll(async () => {
    const { instanceId } = await InstanceIdentity.getPublic()
    const cardKeys = generateInstanceKeyPair()
    const sansSig = {
      v: 1 as const,
      instanceId,
      handle: cardHandle,
      card: { name: 'Card Agent', description: 'Handles support requests' },
    }
    const signedCard: AmtpSignedAgentCard = { ...sansSig, cardSig: signAgentCard(cardKeys.privateKeyPem, sansSig) }

    const cardAgentId = crypto.randomUUID()
    const bareAgentId = crypto.randomUUID()
    hintAgentIds.push(cardAgentId, bareAgentId)
    await db.insert(agents).values([
      {
        id: cardAgentId,
        agentTypeId: 'manager',
        squadId: null,
        status: 'idle',
        amtpHandle: cardHandle,
        cardJson: signedCard,
      },
      {
        id: bareAgentId,
        agentTypeId: 'manager',
        squadId: null,
        status: 'idle',
        amtpHandle: bareHandle,
      },
    ])
    const cardPath = agentIdentityHostPath(`agent_${cardAgentId}`)
    mkdirSync(dirname(cardPath), { recursive: true })
    writeFileSync(cardPath, cardKeys.privateKeyPem, { mode: 0o600 })
    await ensureAgentIdentity(await Agent.mustFind(cardAgentId), `agent_${cardAgentId}`)
    rmSync(cardPath, { force: true })
    await ensureAgentIdentity(await Agent.mustFind(bareAgentId), `agent_${bareAgentId}`)
  })

  afterAll(async () => {
    for (const id of hintAgentIds)
      rmSync(dirname(dirname(agentIdentityHostPath(`agent_${id}`))), { recursive: true, force: true })
    await db.delete(agents).where(inArray(agents.id, hintAgentIds))
  })

  test('an agent with a published card surfaces name+description hints; a card-less agent stays bare', async () => {
    const res = await app.request(PATH, { headers: signedHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { handles: { handle: string; name?: string; description?: string }[] }
    const carded = body.handles.find((h) => h.handle === cardHandle)
    const bare = body.handles.find((h) => h.handle === bareHandle)
    expect(carded).toEqual({ handle: cardHandle, name: 'Card Agent', description: 'Handles support requests' })
    expect(bare).toEqual({ handle: bareHandle })
  })
})
