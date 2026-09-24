import { and, count, eq } from 'drizzle-orm'
import { THEME_PRESET_MAX_PER_USER, validateThemePresetDocument, type ThemePreset } from '@tau/shared'
import { db, themePresets, type DbTx } from '../db'

type Store = typeof db | DbTx
export type ThemePresetRow = typeof themePresets.$inferSelect

export class ThemePresetError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 400
  ) {
    super(message)
    this.name = 'ThemePresetError'
  }
}

export function serializeThemePreset(row: ThemePresetRow): ThemePreset {
  return {
    id: row.id,
    document: row.document,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listThemePresets(ownerUserId: string, store: Store = db): Promise<ThemePresetRow[]> {
  return store
    .select()
    .from(themePresets)
    .where(eq(themePresets.ownerUserId, ownerUserId))
    .orderBy(themePresets.createdAt)
}

/** Owner-scoped read: another user's preset is indistinguishable from a missing one. */
export async function getOwnedThemePreset(
  ownerUserId: string,
  id: string,
  store: Store = db
): Promise<ThemePresetRow | null> {
  const [row] = await store
    .select()
    .from(themePresets)
    .where(and(eq(themePresets.id, id), eq(themePresets.ownerUserId, ownerUserId)))
  return row ?? null
}

/** Same as `getOwnedThemePreset`, but locks the row for a revision-checked mutation. */
async function getOwnedThemePresetForUpdate(ownerUserId: string, id: string, tx: DbTx): Promise<ThemePresetRow | null> {
  const [row] = await tx
    .select()
    .from(themePresets)
    .where(and(eq(themePresets.id, id), eq(themePresets.ownerUserId, ownerUserId)))
    .for('update')
  return row ?? null
}

export async function createThemePreset(ownerUserId: string, rawDocument: unknown): Promise<ThemePresetRow> {
  const result = validateThemePresetDocument(rawDocument)
  if (!result.ok) throw new ThemePresetError(result.error, 422)
  return db.transaction(async (tx) => {
    const [{ value: existing }] = await tx
      .select({ value: count() })
      .from(themePresets)
      .where(eq(themePresets.ownerUserId, ownerUserId))
    if (existing >= THEME_PRESET_MAX_PER_USER)
      throw new ThemePresetError(`You can save at most ${THEME_PRESET_MAX_PER_USER} theme presets.`, 409)
    const [row] = await tx.insert(themePresets).values({ ownerUserId, document: result.document }).returning()
    return row!
  })
}

export async function updateThemePreset(
  ownerUserId: string,
  id: string,
  revision: number,
  rawDocument: unknown
): Promise<ThemePresetRow> {
  const result = validateThemePresetDocument(rawDocument)
  if (!result.ok) throw new ThemePresetError(result.error, 422)
  return db.transaction(async (tx) => {
    const row = await getOwnedThemePresetForUpdate(ownerUserId, id, tx)
    if (!row) throw new ThemePresetError('Theme preset not found', 404)
    if (row.revision !== revision)
      throw new ThemePresetError('Theme preset changed elsewhere — reload it before saving', 409)
    const [updated] = await tx
      .update(themePresets)
      .set({ document: result.document, revision: row.revision + 1, updatedAt: new Date() })
      .where(eq(themePresets.id, id))
      .returning()
    return updated!
  })
}

export async function deleteThemePreset(ownerUserId: string, id: string, revision: number): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await getOwnedThemePresetForUpdate(ownerUserId, id, tx)
    if (!row) throw new ThemePresetError('Theme preset not found', 404)
    if (row.revision !== revision)
      throw new ThemePresetError('Theme preset changed elsewhere — reload it before deleting', 409)
    await tx.delete(themePresets).where(eq(themePresets.id, id))
  })
}
