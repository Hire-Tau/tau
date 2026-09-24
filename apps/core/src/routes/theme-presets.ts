import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  CUSTOM_THEME_MAX_BYTES,
  createThemePresetRequestSchema,
  deleteThemePresetRequestSchema,
  updateThemePresetRequestSchema,
} from '@tau/shared'
import { resolveActingUser } from '../services/rbac'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import {
  createThemePreset,
  deleteThemePreset,
  getOwnedThemePreset,
  listThemePresets,
  serializeThemePreset,
  updateThemePreset,
  ThemePresetError,
} from '../services/theme-presets'

// Self-service like /api/user-preferences: not RBAC-gated. Every route below is
// owner-only (resolveActingUser's caller, including the owner's squadless
// user-assistant agent) — Phase 1 has no sharing routes or cross-user reads.
//
// Body parsing deliberately avoids @hono/zod-validator here: its 'json' target
// swallows ANY c.req.json() error (including the bodyLimit 413 below) and
// rethrows a generic 400 "Malformed JSON" HTTPException, masking the real
// oversized-body status. Parsing the body manually (as /api/user-preferences
// does) keeps the bodyLimit middleware's 413 intact.
export const themePresetsRouter = new Hono()
themePresetsRouter.use('*', bodyLimit({ maxSize: CUSTOM_THEME_MAX_BYTES + 1024 }))
themePresetsRouter.onError((error, c) => {
  if (error instanceof ThemePresetError) return c.json({ error: error.message }, error.status)
  throw error
})

themePresetsRouter.get('/', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  return c.json((await listThemePresets(identity.userId)).map(serializeThemePreset))
})

themePresetsRouter.post('/', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { document?: unknown })
  const parsed = createThemePresetRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400)
  return c.json(serializeThemePreset(await createThemePreset(identity.userId, parsed.data.document)), 201)
})

themePresetsRouter.get('/:id', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const row = await getOwnedThemePreset(identity.userId, c.req.param('id'))
  if (!row) return c.json({ error: 'Theme preset not found' }, 404)
  return c.json(serializeThemePreset(row))
})

themePresetsRouter.put('/:id', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { revision?: unknown; document?: unknown })
  const parsed = updateThemePresetRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400)
  const row = await updateThemePreset(identity.userId, c.req.param('id'), parsed.data.revision, parsed.data.document)
  return c.json(serializeThemePreset(row))
})

themePresetsRouter.delete('/:id', async (c) => {
  const identity = await resolveActingUser(c.get('identity'))
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const body = await parseOptionalJsonObjectBody(c, {} as { revision?: unknown })
  const parsed = deleteThemePresetRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Invalid request body' }, 400)
  await deleteThemePreset(identity.userId, c.req.param('id'), parsed.data.revision)
  return c.json({ ok: true })
})
