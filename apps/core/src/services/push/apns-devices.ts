import { and, eq } from 'drizzle-orm'
import { db } from '../../db'
import { apnsDevices } from '../../db/schema'

export interface RegisterApnsDeviceInput {
  userId: string
  apnsToken: string
  platform: string
  environment?: string
  deviceTokenId?: string | null
  relayBindingToken?: string | null
}

/** Register (or refresh) an APNs device token for a user. Upserts on the unique apnsToken. */
export async function registerApnsDevice(input: RegisterApnsDeviceInput) {
  const [row] = await db
    .insert(apnsDevices)
    .values({
      userId: input.userId,
      apnsToken: input.apnsToken,
      platform: input.platform,
      environment: input.environment ?? 'production',
      deviceTokenId: input.deviceTokenId ?? null,
      relayBindingToken: input.relayBindingToken ?? null,
    })
    .onConflictDoUpdate({
      target: apnsDevices.apnsToken,
      set: {
        userId: input.userId,
        platform: input.platform,
        environment: input.environment ?? 'production',
        deviceTokenId: input.deviceTokenId ?? null,
        relayBindingToken: input.relayBindingToken ?? null,
        lastUsedAt: new Date(),
      },
    })
    .returning({ id: apnsDevices.id })
  return row
}

export async function getApnsDevicesByUser(userId: string) {
  return db.select().from(apnsDevices).where(eq(apnsDevices.userId, userId))
}

/** Delete one of the user's APNs registrations (self-service). Returns true if removed. */
export async function deleteApnsDeviceForUser(id: string, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(apnsDevices)
    .where(and(eq(apnsDevices.id, id), eq(apnsDevices.userId, userId)))
    .returning({ id: apnsDevices.id })
  return deleted.length > 0
}

/** Remove a registration by its APNs token (e.g. after Apple returns Unregistered/410). */
export async function deleteApnsDeviceByToken(apnsToken: string): Promise<void> {
  await db.delete(apnsDevices).where(eq(apnsDevices.apnsToken, apnsToken))
}
