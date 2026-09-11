import { Hono } from 'hono'
import { AgentType } from '../entities/AgentType'
import { PromptInclude } from '../entities/PromptInclude'
import { assertConfigId, assertNonEmptyString } from '../lib/validation/config-ids'
import { promptIncludeSync } from '../services/config-sync'
import { requirePermission } from '../middleware'

const promptIncludesRoutes = new Hono()

function validateBody(body: any, id: string) {
  assertConfigId(id, 'prompt include id')
  assertNonEmptyString(body.content, 'content')
  return {
    id,
    name: (body.name?.trim() || id) as string,
    // `description` is only included when the caller sent it, so PromptInclude.upsert
    // (which special-cases an absent key) leaves an existing description untouched.
    ...(Object.hasOwn(body, 'description') ? { description: body.description?.trim() || null } : {}),
    content: body.content,
  }
}

promptIncludesRoutes.get('/', requirePermission('agent-types:read'), async (c) => {
  const list = await PromptInclude.list({ includeDisabled: true })
  return c.json(list.map((i) => i.toJson()).sort((a, b) => a.name.localeCompare(b.name)))
})

promptIncludesRoutes.get('/:id', requirePermission('agent-types:read'), async (c) => {
  const include = await PromptInclude.find(c.req.param('id'))
  if (!include) return c.json({ error: 'Prompt include not found' }, 404)
  return c.json(include.toJson())
})

promptIncludesRoutes.post('/', requirePermission('agent-types:update'), async (c) => {
  try {
    const body = await c.req.json()
    const input = validateBody(body, body.id)
    if (await PromptInclude.find(input.id)) return c.json({ error: `Prompt include "${input.id}" already exists` }, 409)
    await PromptInclude.upsert(input)
    return c.json((await PromptInclude.mustFind(input.id)).toJson(), 201)
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

promptIncludesRoutes.put('/:id', requirePermission('agent-types:update'), async (c) => {
  try {
    const id = c.req.param('id')
    if (!(await PromptInclude.find(id))) return c.json({ error: 'Prompt include not found' }, 404)
    const input = validateBody(await c.req.json(), id)
    await PromptInclude.upsert(input)
    await promptIncludeSync.recomputeFieldOverrides(id)
    PromptInclude.invalidateCache()
    return c.json((await PromptInclude.mustFind(id)).toJson())
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

promptIncludesRoutes.delete('/:id', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  const include = await PromptInclude.find(id)
  if (!include) return c.json({ error: 'Prompt include not found' }, 404)
  if (include.yamlTemplate != null)
    return c.json({ error: 'Cannot delete a template-based include — disable it instead' }, 400)
  const referencedBy = (await AgentType.list()).filter((t) => (t.includes ?? []).includes(id)).map((t) => t.id)
  if (referencedBy.length) return c.json({ error: `Prompt include "${id}" is used by agent types`, referencedBy }, 409)
  await PromptInclude.delete(id)
  return c.json({ ok: true })
})

promptIncludesRoutes.get('/:id/template-diff', requirePermission('agent-types:read'), async (c) => {
  try {
    return c.json(await promptIncludeSync.getTemplateDiff(c.req.param('id')))
  } catch (e: any) {
    return c.json({ error: e.message }, 404)
  }
})

promptIncludesRoutes.post('/:id/revert-to-template', requirePermission('agent-types:update'), async (c) => {
  try {
    await promptIncludeSync.revertToTemplate(c.req.param('id'))
    PromptInclude.invalidateCache()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

promptIncludesRoutes.post('/:id/revert-template-fields', requirePermission('agent-types:update'), async (c) => {
  try {
    const body = await c.req.json()
    await promptIncludeSync.revertTemplateFields(c.req.param('id'), body.fields ?? [])
    PromptInclude.invalidateCache()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

promptIncludesRoutes.post('/:id/disable', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (!(await PromptInclude.find(id))) return c.json({ error: 'Prompt include not found' }, 404)
  await promptIncludeSync.setDisabled(id, true)
  PromptInclude.invalidateCache()
  return c.json({ ok: true })
})

promptIncludesRoutes.post('/:id/enable', requirePermission('agent-types:update'), async (c) => {
  const id = c.req.param('id')
  if (!(await PromptInclude.find(id))) return c.json({ error: 'Prompt include not found' }, 404)
  await promptIncludeSync.setDisabled(id, false)
  PromptInclude.invalidateCache()
  return c.json({ ok: true })
})

export { promptIncludesRoutes }
