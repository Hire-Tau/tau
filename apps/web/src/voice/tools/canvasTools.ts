import type { WorkspaceVoiceState, VoiceCanvasKind } from '../assistants/workspace/workspaceTypes'
import type { VoiceAssistantTool } from './types'

export type WorkspaceVoiceStateUpdater = WorkspaceVoiceState | ((state: WorkspaceVoiceState) => WorkspaceVoiceState)

export interface CanvasToolEnvironment {
  getWorkspaceState: () => WorkspaceVoiceState
  setWorkspaceState: (updater: WorkspaceVoiceStateUpdater) => void
  createId?: () => string
  now?: () => string
}

const CANVAS_KINDS = ['note', 'plan', 'artifact', 'app'] as const

export const createCanvasTool: VoiceAssistantTool<CanvasToolEnvironment> = {
  definition: {
    type: 'function',
    name: 'create_canvas',
    description: 'Create a workspace canvas for notes, plans, artifacts, or app-related content and make it active.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short canvas title' },
        kind: {
          type: 'string',
          enum: CANVAS_KINDS,
          description: 'Canvas type: note, plan, artifact, or app',
        },
        content: { type: 'string', description: 'Initial canvas content. Plain text or markdown is best.' },
      },
      required: ['title', 'kind', 'content'],
    },
  },
  async execute(args, env) {
    const kind = canvasKindArg(args.kind)
    if (!kind) return { ok: false, error: 'Invalid canvas kind', kind: args.kind }

    const canvasId = createId(env)
    const updatedAt = now(env)
    const title = stringArg(args.title, 'Untitled')
    const content = stringArg(args.content, '')

    env.setWorkspaceState((state) => ({
      ...state,
      canvases: [...state.canvases, { id: canvasId, title, kind, content, updatedAt }],
      activeCanvasId: canvasId,
    }))

    return { ok: true, canvasId }
  },
  summarizeCall(args) {
    return `create canvas: ${stringArg(args.title, 'Untitled')}`
  },
}

export const updateCanvasTool: VoiceAssistantTool<CanvasToolEnvironment> = {
  definition: {
    type: 'function',
    name: 'update_canvas',
    description: 'Update an existing workspace canvas. Only provided fields are changed.',
    parameters: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID to update' },
        title: { type: 'string', description: 'New canvas title' },
        kind: {
          type: 'string',
          enum: CANVAS_KINDS,
          description: 'New canvas type: note, plan, artifact, or app',
        },
        content: { type: 'string', description: 'Replacement canvas content' },
      },
      required: ['canvasId'],
    },
  },
  async execute(args, env) {
    const canvasId = stringArg(args.canvasId, '')
    if (!canvasId) return { ok: false, error: 'canvasId is required' }

    const exists = env.getWorkspaceState().canvases.some((canvas) => canvas.id === canvasId)
    if (!exists) return { ok: false, error: 'Canvas not found', canvasId }

    const kind = typeof args.kind === 'string' ? canvasKindArg(args.kind) : undefined
    if (typeof args.kind === 'string' && !kind) return { ok: false, error: 'Invalid canvas kind', kind: args.kind }

    env.setWorkspaceState((state) => ({
      ...state,
      canvases: state.canvases.map((canvas) => {
        if (canvas.id !== canvasId) return canvas
        return {
          ...canvas,
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          ...(kind ? { kind } : {}),
          ...(typeof args.content === 'string' ? { content: args.content } : {}),
          updatedAt: now(env),
        }
      }),
    }))

    return { ok: true, canvasId }
  },
  summarizeCall(args) {
    return `update canvas: ${stringArg(args.canvasId, '')}`
  },
}

export const showCanvasTool: VoiceAssistantTool<CanvasToolEnvironment> = {
  definition: {
    type: 'function',
    name: 'show_canvas',
    description: 'Make an existing workspace canvas active and visible.',
    parameters: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID to show' },
      },
      required: ['canvasId'],
    },
  },
  async execute(args, env) {
    const canvasId = stringArg(args.canvasId, '')
    if (!canvasId) return { ok: false, error: 'canvasId is required' }

    const exists = env.getWorkspaceState().canvases.some((canvas) => canvas.id === canvasId)
    if (!exists) return { ok: false, error: 'Canvas not found', canvasId }

    env.setWorkspaceState((state) => ({ ...state, activeCanvasId: canvasId }))
    return { ok: true, canvasId }
  },
  summarizeCall(args) {
    return `show canvas: ${stringArg(args.canvasId, '')}`
  },
}

export const closeCanvasTool: VoiceAssistantTool<CanvasToolEnvironment> = {
  definition: {
    type: 'function',
    name: 'close_canvas',
    description: 'Close a workspace canvas. If it is active, no canvas remains active.',
    parameters: {
      type: 'object',
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID to close' },
      },
      required: ['canvasId'],
    },
  },
  async execute(args, env) {
    const canvasId = stringArg(args.canvasId, '')
    if (!canvasId) return { ok: false, error: 'canvasId is required' }

    const exists = env.getWorkspaceState().canvases.some((canvas) => canvas.id === canvasId)
    if (!exists) return { ok: false, error: 'Canvas not found', canvasId }

    env.setWorkspaceState((state) => ({
      ...state,
      canvases: state.canvases.filter((canvas) => canvas.id !== canvasId),
      activeCanvasId: state.activeCanvasId === canvasId ? null : state.activeCanvasId,
    }))

    return { ok: true, canvasId }
  },
  summarizeCall(args) {
    return `close canvas: ${stringArg(args.canvasId, '')}`
  },
}

export const displayAppTool: VoiceAssistantTool<CanvasToolEnvironment> = {
  definition: {
    type: 'function',
    name: 'display_app',
    description: 'Display a lightweight app preview in the workspace from either a URL or inline HTML.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Displayed app title' },
        url: { type: 'string', description: 'URL to display' },
        html: { type: 'string', description: 'Inline HTML to display' },
      },
      required: ['title'],
    },
  },
  async execute(args, env) {
    const title = stringArg(args.title, 'Untitled app')
    const url = typeof args.url === 'string' ? args.url : undefined
    const html = typeof args.html === 'string' ? args.html : undefined

    if ((url === undefined && html === undefined) || (url !== undefined && html !== undefined)) {
      return { ok: false, error: 'Exactly one of url or html is required' }
    }

    const validatedUrl = url === undefined ? undefined : validateDisplayAppUrl(url)
    if (validatedUrl && !validatedUrl.ok) return validatedUrl

    const appId = createId(env)
    env.setWorkspaceState((state) => ({
      ...state,
      displayedApps: [
        ...state.displayedApps,
        {
          id: appId,
          title,
          ...(validatedUrl?.ok ? { url: validatedUrl.url } : {}),
          ...(html !== undefined ? { html, contentMode: 'sandboxed-html' as const } : {}),
          status: 'ready',
        },
      ],
    }))

    return { ok: true, appId }
  },
  summarizeCall(args) {
    return `display app: ${stringArg(args.title, 'Untitled app')}`
  },
}

export const canvasTools = [createCanvasTool, updateCanvasTool, showCanvasTool, displayAppTool, closeCanvasTool]

function stringArg(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function canvasKindArg(value: unknown): VoiceCanvasKind | undefined {
  return CANVAS_KINDS.includes(value as VoiceCanvasKind) ? (value as VoiceCanvasKind) : undefined
}

function validateDisplayAppUrl(
  url: string
): { ok: true; url: string } | { ok: false; error: string; url?: string; protocol?: string } {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { ok: false, error: 'Invalid app URL', url }
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'Unsupported app URL protocol', protocol: parsedUrl.protocol }
  }

  return { ok: true, url }
}

function createId(env: CanvasToolEnvironment): string {
  if (env.createId) return env.createId()
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function now(env: CanvasToolEnvironment): string {
  return env.now?.() ?? new Date().toISOString()
}
