import { eq } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { db } from '../db'
import { instanceIdentity } from '../db/schema'
import { generateInstanceKeyPair, instanceIdFromPublicKeyPem } from '../services/amtp/crypto'

const SINGLETON_ID = 'singleton'
export type InstanceIdentityRow = InferSelectModel<typeof instanceIdentity>

export class InstanceIdentity {
  id!: string
  instanceId!: string
  publicKeyPem!: string
  privateKeyPem!: string
  createdAt!: Date

  constructor(row: InstanceIdentityRow) {
    Object.assign(this, row)
  }

  toPublicJson(): { instanceId: string; publicKeyPem: string } {
    return { instanceId: this.instanceId, publicKeyPem: this.publicKeyPem }
  }

  static async getOrCreate(): Promise<InstanceIdentity> {
    const [existing] = await db.select().from(instanceIdentity).where(eq(instanceIdentity.id, SINGLETON_ID)).limit(1)
    if (existing) return new InstanceIdentity(existing)

    const { publicKeyPem, privateKeyPem } = generateInstanceKeyPair()
    const instanceId = instanceIdFromPublicKeyPem(publicKeyPem)
    // Idempotent under concurrent first-boot: ignore the insert if another worker won the race.
    await db
      .insert(instanceIdentity)
      .values({ id: SINGLETON_ID, instanceId, publicKeyPem, privateKeyPem })
      .onConflictDoNothing()
    const [row] = await db.select().from(instanceIdentity).where(eq(instanceIdentity.id, SINGLETON_ID)).limit(1)
    return new InstanceIdentity(row)
  }

  static async getPublic(): Promise<{ instanceId: string; publicKeyPem: string }> {
    return (await InstanceIdentity.getOrCreate()).toPublicJson()
  }
}
