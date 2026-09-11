import { SharedPrompt } from '../../entities/SharedPrompt'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('agent-types')

/**
 * The system prompt an agent of this type actually receives before runtime
 * sections: the type's own prompt followed by each enabled include, in list
 * order, joined by blank lines. This is the exact join config-sync used to
 * bake includes in, so resolved prompts are unchanged by the split.
 */
export async function composeAgentTypePrompt(agentType: {
  id: string
  systemPrompt: string
  includes?: string[] | null
}): Promise<string> {
  const ids = agentType.includes ?? []
  if (ids.length === 0) return agentType.systemPrompt
  const found = await SharedPrompt.findMany(ids)
  const parts: string[] = [agentType.systemPrompt]
  for (const id of ids) {
    const include = found.get(id)
    if (!include) {
      log.warn(`agent type '${agentType.id}' lists unknown shared prompt '${id}'; skipping`)
      continue
    }
    if (include.disabled) continue
    parts.push(include.content)
  }
  return parts.join('\n\n')
}
