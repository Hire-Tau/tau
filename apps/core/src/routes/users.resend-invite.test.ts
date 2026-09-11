import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { eq, like } from 'drizzle-orm'
import { usersRouter } from './users'
import { authRouter } from './auth'
import { identityMiddleware } from '../middleware/identity'
import {
  createTestAdmin,
  createTestUser,
  createTestRole,
  createTestCredential,
  assignRole,
  authHeaders,
  cleanupTestRbac,
} from '../test-utils'
import type { TestUser } from '../test-utils/rbac'
import { db } from '../db'
import { emailVerifications } from '../db/schema'
import { sesSendMock } from '../test-utils/ses-mock'
import { verifyEmailCode, VERIFICATION_RATE_LIMIT } from '../services/auth/email'

// POST /api/users mails the invite exactly once and 409s on an address that
// already exists, so a lapsed invite used to leave an admin with no recourse but
// to delete the account and re-invite. POST /api/users/:id/invite closes that
// hole — and its central obligation is that a RESEND leaves exactly ONE live
// link: if the superseded link kept redeeming, "resend" would silently mean
// "issue a second credential for this account".

const app = new Hono()
// Auth first, and unauthenticated: the deep-link endpoints are what an invitee
// hits, and they are the surface that proves an old link no longer redeems.
app.route('/api/auth', authRouter)
app.use('/api/*', identityMiddleware)
app.route('/api/users', usersRouter)

const prefix = `resend-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const priorFrom = process.env.SES_FROM_ADDRESS

let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
})

afterAll(async () => {
  await cleanupTestRbac(prefix)
  await db.delete(emailVerifications).where(like(emailVerifications.email, `${prefix}%`))
})

beforeEach(() => {
  sesSendMock.mockReset()
  sesSendMock.mockResolvedValue({ MessageId: 'test-message-id' })
  delete process.env.SES_FROM_ADDRESS
})

afterEach(async () => {
  sesSendMock.mockReset()
  sesSendMock.mockResolvedValue({ MessageId: 'test-message-id' })
  if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
  else process.env.SES_FROM_ADDRESS = priorFrom
  // Issuance is rate-limited per address over a 15-minute window, so rows must
  // not survive into the next test even though every test uses a fresh address.
  await db.delete(emailVerifications).where(like(emailVerifications.email, `${prefix}%`))
})

/** Create a user through the real invite route and return its first challenge. */
async function inviteFresh(token = admin.token) {
  const email = `${prefix}-invitee-${crypto.randomUUID().slice(0, 8)}@test.local`
  const res = await app.request('/api/users', {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as any
  return { email, id: body.id as string, code: body.inviteCode as string, url: body.inviteUrl as string }
}

function resend(userId: string, token = admin.token) {
  return app.request(`/api/users/${userId}/invite`, { method: 'POST', headers: authHeaders(token) })
}

/** The raw deep-link token carried by an invite URL. */
function tokenOf(inviteUrl: string): string {
  return new URL(inviteUrl).searchParams.get('token')!
}

/** Open the passkey ceremony as the invitee would, using only the link. */
function openLink(token: string) {
  return app.request('/api/auth/register/token/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

/** Every challenge row ever written for an address (rows are stored lowercased). */
function challengesFor(email: string) {
  return db.select().from(emailVerifications).where(eq(emailVerifications.email, email.toLowerCase()))
}

// ── A. The resend supersedes the previous invite ─────────────────────────────

describe('POST /api/users/:id/invite supersedes the outstanding invite', () => {
  it('the OLD link no longer redeems while the NEW one does', async () => {
    const first = await inviteFresh()
    // Sanity: before the resend the original link is live, so the assertion
    // below is about the resend and not about a link that never worked.
    expect((await openLink(tokenOf(first.url))).status).toBe(200)

    const res = await resend(first.id)
    expect(res.status).toBe(200)
    const second = (await res.json()) as any

    expect((await openLink(tokenOf(first.url))).status).toBe(401)
    expect((await openLink(tokenOf(second.inviteUrl))).status).toBe(200)
  })

  it('the OLD 6-digit code no longer verifies either — both presentations die together', async () => {
    const first = await inviteFresh()
    const res = await resend(first.id)
    const second = (await res.json()) as any

    expect(await verifyEmailCode(first.email, first.code)).toBe(false)
    expect(await verifyEmailCode(first.email, second.inviteCode)).toBe(true)
  })

  it('leaves exactly one unconsumed challenge, so the Users list shows one expiry', async () => {
    const first = await inviteFresh()
    await resend(first.id)

    const rows = await challengesFor(first.email)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.usedAt === null)).toHaveLength(1)
  })

  it('supersedes every outstanding challenge, not just the newest', async () => {
    const first = await inviteFresh()
    // A second live challenge for the same address — the invitee also asked for
    // a code themselves, say. Newest-wins would leave this one redeemable.
    await db.insert(emailVerifications).values({
      email: first.email.toLowerCase(),
      code: 'other-code-hash',
      tokenHash: `other-token-hash-${first.id}`,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await resend(first.id)

    const rows = await challengesFor(first.email)
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.usedAt === null)).toHaveLength(1)
    expect((await openLink(tokenOf(first.url))).status).toBe(401)
  })
})

describe('explicit invite link creation', () => {
  it('returns a replacement link without email, even when email delivery is configured', async () => {
    const first = await inviteFresh()
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    sesSendMock.mockClear()
    const res = await app.request(`/api/users/${first.id}/invite?delivery=link`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inviteUrl).toBeString()
    expect(sesSendMock).not.toHaveBeenCalled()
    expect((await openLink(tokenOf(first.url))).status).toBe(401)
    expect((await openLink(tokenOf(body.inviteUrl))).status).toBe(200)
    expect((await challengesFor(first.email)).filter((row) => row.usedAt === null)).toHaveLength(1)
  })

  it('rejects an unknown delivery mode without replacing the existing link', async () => {
    const first = await inviteFresh()
    const res = await app.request(`/api/users/${first.id}/invite?delivery=other`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(400)
    expect(await challengesFor(first.email)).toHaveLength(1)
    expect((await openLink(tokenOf(first.url))).status).toBe(200)
  })

  it('requires invite permission for link creation too', async () => {
    const first = await inviteFresh()
    const reader = await createTestUser({ prefix })
    const res = await app.request(`/api/users/${first.id}/invite?delivery=link`, {
      method: 'POST',
      headers: authHeaders(reader.token),
    })
    expect(res.status).toBe(403)
    expect(await challengesFor(first.email)).toHaveLength(1)
  })
})

// ── B. Delivery ──────────────────────────────────────────────────────────────

describe('POST /api/users/:id/invite delivers the invite', () => {
  function sentInvitation(index: number) {
    const command = sesSendMock.mock.calls[index]?.[0] as {
      input: {
        Source: string
        Destination: { ToAddresses: string[] }
        Message: { Body: { Text: { Data: string }; Html: { Data: string } } }
      }
    }
    const message = command.input.Message.Body
    const link = message.Text.Data.split('\n').find((line) => /^https?:\/\/\S+\/register\?token=/.test(line))!
    expect(link).toBeString()
    expect(message.Html.Data).toContain(link)
    expect(message.Text.Data).toContain('expires in 7 days')
    return { ...command.input, link }
  }

  it('after a successful initial email, resends to the same recipient with a redeemable replacement link', async () => {
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    const first = await inviteFresh()
    const initialEmail = sentInvitation(0)
    expect((await openLink(tokenOf(initialEmail.link))).status).toBe(200)

    const response = await resend(first.id)
    expect(response.status).toBe(200)
    expect(sesSendMock).toHaveBeenCalledTimes(2)
    const replacementEmail = sentInvitation(1)
    expect(replacementEmail.Source).toBe(initialEmail.Source)
    expect(replacementEmail.Destination.ToAddresses).toEqual([first.email])
    expect(replacementEmail.Destination).toEqual(initialEmail.Destination)
    expect(replacementEmail.link).not.toBe(initialEmail.link)
    expect((await response.json()).inviteEmailFailed).toBeUndefined()
    expect((await openLink(tokenOf(initialEmail.link))).status).toBe(401)
    expect((await openLink(tokenOf(replacementEmail.link))).status).toBe(200)
  })

  it('reports a failed resend and delivers a usable link when the admin retries', async () => {
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    const first = await inviteFresh()
    const initialEmail = sentInvitation(0)
    sesSendMock.mockRejectedValueOnce(new Error('Test mail provider unavailable'))

    const failed = await resend(first.id)
    expect(failed.status).toBe(200)
    expect(await failed.json()).toMatchObject({ id: first.id, inviteEmailFailed: true })
    expect((await openLink(tokenOf(initialEmail.link))).status).toBe(401)

    const retried = await resend(first.id)
    expect(retried.status).toBe(200)
    expect((await retried.json()).inviteEmailFailed).toBeUndefined()
    expect(sesSendMock).toHaveBeenCalledTimes(3)
    const retryEmail = sentInvitation(2)
    expect(retryEmail.Destination.ToAddresses).toEqual([first.email])
    expect((await openLink(tokenOf(retryEmail.link))).status).toBe(200)
    expect((await challengesFor(first.email)).filter((row) => row.usedAt === null)).toHaveLength(1)
  })

  it('MAILS a fresh invite when email is configured, echoing nothing back', async () => {
    const first = await inviteFresh()
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    sesSendMock.mockClear()

    const res = await resend(first.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(sesSendMock).toHaveBeenCalledTimes(1)
    expect(body.inviteCode).toBeUndefined()
    expect(body.inviteUrl).toBeUndefined()
    expect(body.id).toBe(first.id)
    expect(body.email).toBe(first.email)
  })

  it('mails the same link-only invite body creation sends', async () => {
    const first = await inviteFresh()
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
    sesSendMock.mockClear()

    await resend(first.id)
    const command = sesSendMock.mock.calls[0]?.[0] as {
      input: { Message: { Subject: { Data: string }; Body: { Text: { Data: string } } } }
    }
    expect(command.input.Message.Subject.Data).toMatch(/invited/i)
    expect(command.input.Message.Body.Text.Data).toMatch(/\/register\?token=[\w-]{20,}/)
    expect(command.input.Message.Body.Text.Data).not.toMatch(/\b\d{6}\b/)
  })

  it('returns the code + link instead of failing on a no-email install', async () => {
    const first = await inviteFresh()
    const res = await resend(first.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(sesSendMock).not.toHaveBeenCalled()
    expect(body.inviteCode).toMatch(/^\d{6}$/)
    expect(body.inviteUrl).toContain('/register?token=')
    expect(body.inviteUrl).not.toBe(first.url)
  })
})

// ── C. Who it refuses ────────────────────────────────────────────────────────

describe('POST /api/users/:id/invite refuses what it should', () => {
  it('refuses a user who already holds a passkey', async () => {
    const first = await inviteFresh()
    await createTestCredential({ userId: first.id })

    const res = await resend(first.id)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('already completed setup')
    expect(sesSendMock).not.toHaveBeenCalled()
  })

  it('leaves an onboarded user’s outstanding challenges untouched when it refuses', async () => {
    const first = await inviteFresh()
    await createTestCredential({ userId: first.id })

    expect((await resend(first.id)).status).toBe(409)
    // The refusal must not have burned anything on the way out.
    expect((await openLink(tokenOf(first.url))).status).toBe(200)
  })

  it('404s for a user that does not exist', async () => {
    const res = await resend('00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  it('rejects a caller without users:create', async () => {
    const first = await inviteFresh()
    const pfx = `${prefix}-noperm`
    const weak = await createTestUser({ prefix: pfx })
    // Deliberately close-but-not-enough: reading and editing users is not the
    // right to mint a passkey-registration credential.
    const role = await createTestRole({ permissions: ['users:read', 'users:update'], prefix: pfx })
    await assignRole({ userId: weak.id, roleId: role.id, scope: 'system' })
    try {
      const res = await resend(first.id, weak.token)
      expect(res.status).toBe(403)
      // Refused before anything was superseded.
      expect((await openLink(tokenOf(first.url))).status).toBe(200)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })

  it('rejects an unauthenticated caller', async () => {
    const first = await inviteFresh()
    const res = await app.request(`/api/users/${first.id}/invite`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('allows a non-admin holding exactly users:create', async () => {
    const pfx = `${prefix}-inviter`
    const inviter = await createTestUser({ prefix: pfx })
    const role = await createTestRole({ permissions: ['users:create'], prefix: pfx })
    await assignRole({ userId: inviter.id, roleId: role.id, scope: 'system' })
    try {
      const first = await inviteFresh(inviter.token)
      expect((await resend(first.id, inviter.token)).status).toBe(200)
    } finally {
      await cleanupTestRbac(pfx)
    }
  })
})

// ── D. Rate limit ────────────────────────────────────────────────────────────

describe('POST /api/users/:id/invite is rate limited', () => {
  it('refuses past the per-address issuance budget an admin cannot be used to exceed', async () => {
    // Creation issues the first challenge, so VERIFICATION_RATE_LIMIT - 1
    // resends fit inside the window and the next one is refused.
    const first = await inviteFresh()
    for (let i = 0; i < VERIFICATION_RATE_LIMIT - 1; i++) {
      expect((await resend(first.id)).status).toBe(200)
    }

    const res = await resend(first.id)
    expect(res.status).toBe(429)
    expect((await res.json()).error).toMatch(/too many/i)
  })

  it('a rate-limited resend leaves the live invite alone', async () => {
    const first = await inviteFresh()
    for (let i = 0; i < VERIFICATION_RATE_LIMIT - 1; i++) await resend(first.id)
    const live = await challengesFor(first.email)
    const liveToken = live.filter((r) => r.usedAt === null)
    expect(liveToken).toHaveLength(1)

    expect((await resend(first.id)).status).toBe(429)

    const after = await challengesFor(first.email)
    // Same single live row: the refusal neither issued nor burned anything.
    expect(after).toHaveLength(live.length)
    expect(after.filter((r) => r.usedAt === null).map((r) => r.id)).toEqual([liveToken[0].id])
  })
})
