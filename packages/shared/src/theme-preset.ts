import { z } from 'zod'
import { validateCustomTheme, type CustomThemeDocument, type CustomThemeValidation } from './custom-theme'
import { SYNC_THEME_DESCRIPTORS } from './theme-preferences'

/**
 * Phase 1: every user gets a library of saved theme presets, private by
 * default. `visibility` exists now so Phase 2 (instance-wide sharing) only
 * needs to add routes/UI on top of this schema — Phase 1 itself never sets
 * it to 'instance' and never reads another user's presets; every route here
 * is owner-only.
 */
export type ThemePresetVisibility = 'private' | 'instance'

export function isThemePresetVisibility(value: unknown): value is ThemePresetVisibility {
  return value === 'private' || value === 'instance'
}

/** Per-user library size cap, enforced by the create route (409/422 on overflow). */
export const THEME_PRESET_MAX_PER_USER = 50

/** The wire/API shape. Name lives at `document.name` (single source — renaming
 * a preset is a document name change, there is no separate name field to drift). */
export interface ThemePreset {
  id: string
  document: CustomThemeDocument
  visibility: ThemePresetVisibility
  ownerUserId: string
  revision: number
  createdAt: string
  updatedAt: string
}

/** Accepts either a parsed document object or a raw JSON string, and validates/
 * normalizes it exactly like a directly-imported custom theme document (v1 or v2). */
export function validateThemePresetDocument(
  raw: unknown,
  builtins: readonly {
    readonly id: string
    readonly label: string
    readonly kind: 'dual' | 'unified'
  }[] = SYNC_THEME_DESCRIPTORS
): CustomThemeValidation {
  if (raw === null || raw === undefined) return { ok: false, error: 'Theme document is required.' }
  let json: string
  try {
    json = typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    return { ok: false, error: 'Theme document must be JSON-serializable.' }
  }
  return validateCustomTheme(json, builtins)
}

const requiredDocument = z.unknown().refine((value) => value !== undefined, { message: 'document is required' })

/** Phase 1 request bodies never take `visibility` — there is no sharing route yet. */
export const createThemePresetRequestSchema = z.object({ document: requiredDocument }).strict()
export const updateThemePresetRequestSchema = z
  .object({ revision: z.number().int().nonnegative(), document: requiredDocument })
  .strict()
export const deleteThemePresetRequestSchema = z.object({ revision: z.number().int().nonnegative() }).strict()

export type CreateThemePresetRequest = z.infer<typeof createThemePresetRequestSchema>
export type UpdateThemePresetRequest = z.infer<typeof updateThemePresetRequestSchema>
export type DeleteThemePresetRequest = z.infer<typeof deleteThemePresetRequestSchema>
