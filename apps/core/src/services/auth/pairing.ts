import { createHash, randomBytes } from 'crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { pairingCodes, users } from '../../db/schema'
import { createDeviceToken } from './device-tokens'

/** Pairing codes are short-lived — they live only long enough to scan a QR. */
export const PAIRING_CODE_TTL_MS = 90_000

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** High-entropy URL-safe code (carried in a QR, never typed by a human). */
function generatePairingCode(): string {
  return randomBytes(18).toString('base64url')
}

export interface PairedUser {
  id: string
  email: string
  displayName: string | null
  disabledAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** (web, authenticated) Mint a single-use pairing code bound to the user. */
export async function createPairingCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS)
  await db.insert(pairingCodes).values({ codeHash: hashCode(code), userId, expiresAt })
  return { code, expiresAt }
}

/**
 * (mobile, unauthenticated) Claim a scanned code → a long-lived device token.
 * Single-use via an atomic conditional update (only the claim that flips claimedAt from NULL wins),
 * which closes the select-then-update race under concurrency.
 */
export async function claimPairingCode(input: {
  code: string
  name: string
  platform: string
}): Promise<{ token: string; deviceId: string; user: PairedUser } | null> {
  const codeHash = hashCode(input.code)

  const [claimed] = await db
    .update(pairingCodes)
    .set({ claimedAt: new Date() })
    .where(
      and(eq(pairingCodes.codeHash, codeHash), gt(pairingCodes.expiresAt, new Date()), isNull(pairingCodes.claimedAt))
    )
    .returning({ userId: pairingCodes.userId })
  if (!claimed) return null

  const [user] = await db.select().from(users).where(eq(users.id, claimed.userId)).limit(1)
  if (!user || user.disabledAt) return null

  const { token, id: deviceId } = await createDeviceToken({
    userId: claimed.userId,
    name: input.name,
    platform: input.platform,
  })

  return {
    token,
    deviceId,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      disabledAt: user.disabledAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  }
}
