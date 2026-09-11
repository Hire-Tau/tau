import { afterEach, beforeEach } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, settings } from '../db'
import { INTEGRATION_ENABLED_PREFIX } from '../services/integrations/provider-state'

/** Opt runtime fixtures into integrations explicitly; production defaults stay off. */
export function useEnabledIntegrationFixtures(...providers: string[]) {
  const keys = providers.map((provider) => INTEGRATION_ENABLED_PREFIX + provider)
  let previous: (typeof settings.$inferSelect)[] = []
  beforeEach(async () => {
    previous = await db.select().from(settings).where(inArray(settings.key, keys))
    for (const key of keys) {
      await db
        .insert(settings)
        .values({ key, value: 'true', updatedBy: 'test-fixture' })
        .onConflictDoUpdate({ target: settings.key, set: { value: 'true' } })
    }
  })
  afterEach(async () => {
    for (const key of keys) {
      const row = previous.find((item) => item.key === key)
      if (row) await db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row })
      else await db.delete(settings).where(eq(settings.key, key))
    }
  })
}
