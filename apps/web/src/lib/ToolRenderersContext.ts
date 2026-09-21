import { createContext, useContext } from 'react'
import { agentToolRenderers, type ToolRenderers } from './tool-renderers'

export const ToolRenderersContext = createContext<ToolRenderers | undefined>(undefined)
/** Surface-specific editor/Assistant tools apply to live and persisted blocks alike. */
export const useToolRenderers = () => useContext(ToolRenderersContext) ?? agentToolRenderers
