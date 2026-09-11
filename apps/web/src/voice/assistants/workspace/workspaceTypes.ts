export type VoiceCanvasKind = 'note' | 'plan' | 'artifact' | 'app'

export interface WorkspaceVoiceState {
  canvases: VoiceCanvas[]
  activeCanvasId: string | null
  displayedApps: VoiceDisplayedApp[]
  spokenArtifactUpdateIds?: string[]
  spokenArtifactQuestionIds?: string[]
  spokenInboxIds?: string[]
  spokenWaitingInputAgentIds?: string[]
  activeArtifactDisplay?: WorkspaceArtifactDisplay
}

export type WorkspaceArtifactDisplay = { mode: 'latest' } | { mode: 'specific'; agentId: string; artifactId: string }

export interface VoiceCanvas {
  id: string
  title: string
  kind: VoiceCanvasKind
  content: string
  updatedAt: string
}

export interface VoiceDisplayedApp {
  id: string
  title: string
  url?: string
  /** Inline HTML supplied by voice tools. Renderers must sandbox this content before displaying it. */
  html?: string
  contentMode?: 'sandboxed-html'
  status: 'loading' | 'ready' | 'error'
}

export function createInitialWorkspaceVoiceState(): WorkspaceVoiceState {
  return {
    canvases: [],
    activeCanvasId: null,
    displayedApps: [],
    spokenArtifactUpdateIds: [],
    spokenArtifactQuestionIds: [],
    spokenInboxIds: [],
    spokenWaitingInputAgentIds: [],
    activeArtifactDisplay: { mode: 'latest' },
  }
}
