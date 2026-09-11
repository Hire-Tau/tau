import type { ScopeRequest } from './scope-expander'

export interface DefaultLayers {
  squad?: Partial<ScopeRequest>
  agentType?: Partial<ScopeRequest>
  agent?: Partial<ScopeRequest>
  request?: Partial<ScopeRequest>
}

const KEYS: (keyof ScopeRequest)[] = ['sourceTypes', 'paths', 'sensitivity', 'sourceSquadIds']

export function resolveSearchDefaults(layers: DefaultLayers): ScopeRequest {
  const result: ScopeRequest = {}
  const layerOrder: (Partial<ScopeRequest> | undefined)[] = [
    layers.squad,
    layers.agentType,
    layers.agent,
    layers.request,
  ]

  for (const layer of layerOrder) {
    if (!layer) continue
    for (const key of KEYS) {
      const value = layer[key]
      if (value !== undefined) {
        ;(result as Record<string, unknown>)[key] = value
      }
    }
  }

  return result
}
