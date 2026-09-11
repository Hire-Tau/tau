import { describe, expect, test } from 'bun:test'
import {
  closeCanvasTool,
  createCanvasTool,
  displayAppTool,
  showCanvasTool,
  updateCanvasTool,
  type CanvasToolEnvironment,
} from './canvasTools'
import type { WorkspaceVoiceState } from '../assistants/workspace/workspaceTypes'

function createEnv(initial?: Partial<WorkspaceVoiceState>): CanvasToolEnvironment {
  let state: WorkspaceVoiceState = {
    canvases: [],
    activeCanvasId: null,
    displayedApps: [],
    ...initial,
  }

  return {
    getWorkspaceState: () => state,
    setWorkspaceState: (updater) => {
      state = typeof updater === 'function' ? updater(state) : updater
    },
    createId: (() => {
      let nextId = 1
      return () => `id-${nextId++}`
    })(),
    now: () => '2026-04-30T15:36:27.000Z',
  }
}

describe('canvas tools', () => {
  test('create_canvas adds a canvas and makes it active', async () => {
    const env = createEnv()

    await expect(createCanvasTool.execute({ title: 'Plan', kind: 'plan', content: 'Step 1' }, env)).resolves.toEqual({
      ok: true,
      canvasId: 'id-1',
    })

    expect(env.getWorkspaceState()).toEqual({
      canvases: [
        {
          id: 'id-1',
          title: 'Plan',
          kind: 'plan',
          content: 'Step 1',
          updatedAt: '2026-04-30T15:36:27.000Z',
        },
      ],
      activeCanvasId: 'id-1',
      displayedApps: [],
    })
  })

  test('create_canvas rejects invalid kind and preserves state', async () => {
    const initialState: WorkspaceVoiceState = {
      canvases: [],
      activeCanvasId: null,
      displayedApps: [],
    }
    const env = createEnv(initialState)

    await expect(createCanvasTool.execute({ title: 'Plan', kind: 'unknown', content: 'Step 1' }, env)).resolves.toEqual(
      {
        ok: false,
        error: 'Invalid canvas kind',
        kind: 'unknown',
      }
    )

    expect(env.getWorkspaceState()).toEqual(initialState)
  })

  test('update_canvas updates content, title, and kind when provided', async () => {
    const env = createEnv({
      canvases: [
        {
          id: 'canvas-1',
          title: 'Old title',
          kind: 'note',
          content: 'Old content',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
      ],
    })

    await expect(
      updateCanvasTool.execute(
        { canvasId: 'canvas-1', title: 'New title', kind: 'artifact', content: 'New content' },
        env
      )
    ).resolves.toEqual({ ok: true, canvasId: 'canvas-1' })

    expect(env.getWorkspaceState().canvases[0]).toEqual({
      id: 'canvas-1',
      title: 'New title',
      kind: 'artifact',
      content: 'New content',
      updatedAt: '2026-04-30T15:36:27.000Z',
    })
  })

  test('update_canvas returns an error for missing canvas and preserves state', async () => {
    const initialState: WorkspaceVoiceState = {
      activeCanvasId: 'canvas-1',
      canvases: [
        {
          id: 'canvas-1',
          title: 'Old title',
          kind: 'note',
          content: 'Old content',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
      ],
      displayedApps: [],
    }
    const env = createEnv(initialState)

    await expect(updateCanvasTool.execute({ canvasId: 'missing', content: 'New content' }, env)).resolves.toEqual({
      ok: false,
      error: 'Canvas not found',
      canvasId: 'missing',
    })

    expect(env.getWorkspaceState()).toEqual(initialState)
  })

  test('update_canvas rejects invalid kind and preserves state', async () => {
    const initialState: WorkspaceVoiceState = {
      activeCanvasId: 'canvas-1',
      canvases: [
        {
          id: 'canvas-1',
          title: 'Old title',
          kind: 'note',
          content: 'Old content',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
      ],
      displayedApps: [],
    }
    const env = createEnv(initialState)

    await expect(updateCanvasTool.execute({ canvasId: 'canvas-1', kind: 'unknown' }, env)).resolves.toEqual({
      ok: false,
      error: 'Invalid canvas kind',
      kind: 'unknown',
    })

    expect(env.getWorkspaceState()).toEqual(initialState)
  })

  test('show_canvas changes activeCanvasId', async () => {
    const env = createEnv({
      canvases: [
        {
          id: 'canvas-1',
          title: 'Plan',
          kind: 'plan',
          content: '',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
      ],
    })

    await expect(showCanvasTool.execute({ canvasId: 'canvas-1' }, env)).resolves.toEqual({
      ok: true,
      canvasId: 'canvas-1',
    })

    expect(env.getWorkspaceState().activeCanvasId).toBe('canvas-1')
  })

  test('show_canvas returns an error for missing canvas and preserves state', async () => {
    const initialState: WorkspaceVoiceState = {
      activeCanvasId: 'canvas-1',
      canvases: [
        {
          id: 'canvas-1',
          title: 'Plan',
          kind: 'plan',
          content: '',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
      ],
      displayedApps: [],
    }
    const env = createEnv(initialState)

    await expect(showCanvasTool.execute({ canvasId: 'missing' }, env)).resolves.toEqual({
      ok: false,
      error: 'Canvas not found',
      canvasId: 'missing',
    })

    expect(env.getWorkspaceState()).toEqual(initialState)
  })

  test('close_canvas clears the active canvas if it is closed', async () => {
    const env = createEnv({
      activeCanvasId: 'canvas-1',
      canvases: [
        {
          id: 'canvas-1',
          title: 'Plan',
          kind: 'plan',
          content: '',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
        {
          id: 'canvas-2',
          title: 'Notes',
          kind: 'note',
          content: '',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
      ],
    })

    await expect(closeCanvasTool.execute({ canvasId: 'canvas-1' }, env)).resolves.toEqual({
      ok: true,
      canvasId: 'canvas-1',
    })

    expect(env.getWorkspaceState()).toEqual({
      canvases: [
        {
          id: 'canvas-2',
          title: 'Notes',
          kind: 'note',
          content: '',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
      ],
      activeCanvasId: null,
      displayedApps: [],
    })
  })

  test('close_canvas returns an error for missing canvas and preserves state', async () => {
    const initialState: WorkspaceVoiceState = {
      activeCanvasId: 'canvas-1',
      canvases: [
        {
          id: 'canvas-1',
          title: 'Plan',
          kind: 'plan',
          content: '',
          updatedAt: '2026-04-30T00:00:00.000Z',
        },
      ],
      displayedApps: [],
    }
    const env = createEnv(initialState)

    await expect(closeCanvasTool.execute({ canvasId: 'missing' }, env)).resolves.toEqual({
      ok: false,
      error: 'Canvas not found',
      canvasId: 'missing',
    })

    expect(env.getWorkspaceState()).toEqual(initialState)
  })

  test('display_app adds a displayed app with ready status when given exactly one of url or sandboxed html', async () => {
    const urlEnv = createEnv()
    const htmlEnv = createEnv()

    await expect(displayAppTool.execute({ title: 'Docs', url: 'https://example.com' }, urlEnv)).resolves.toEqual({
      ok: true,
      appId: 'id-1',
    })
    await expect(displayAppTool.execute({ title: 'Preview', html: '<h1>Hello</h1>' }, htmlEnv)).resolves.toEqual({
      ok: true,
      appId: 'id-1',
    })

    expect(urlEnv.getWorkspaceState().displayedApps).toEqual([
      { id: 'id-1', title: 'Docs', url: 'https://example.com', status: 'ready' },
    ])
    expect(htmlEnv.getWorkspaceState().displayedApps).toEqual([
      {
        id: 'id-1',
        title: 'Preview',
        html: '<h1>Hello</h1>',
        contentMode: 'sandboxed-html',
        status: 'ready',
      },
    ])
  })

  test('display_app rejects missing url/html and preserves state', async () => {
    const initialState: WorkspaceVoiceState = {
      canvases: [],
      activeCanvasId: null,
      displayedApps: [],
    }
    const env = createEnv(initialState)

    await expect(displayAppTool.execute({ title: 'Preview' }, env)).resolves.toEqual({
      ok: false,
      error: 'Exactly one of url or html is required',
    })

    expect(env.getWorkspaceState()).toEqual(initialState)
  })

  test('display_app rejects both url and html and preserves state', async () => {
    const initialState: WorkspaceVoiceState = {
      canvases: [],
      activeCanvasId: null,
      displayedApps: [],
    }
    const env = createEnv(initialState)

    await expect(
      displayAppTool.execute({ title: 'Preview', url: 'https://example.com', html: '<h1>Hello</h1>' }, env)
    ).resolves.toEqual({
      ok: false,
      error: 'Exactly one of url or html is required',
    })

    expect(env.getWorkspaceState()).toEqual(initialState)
  })

  test('display_app rejects invalid URLs and unsupported protocols while preserving state', async () => {
    const invalidUrlEnv = createEnv()
    const unsupportedProtocolEnv = createEnv()

    await expect(displayAppTool.execute({ title: 'Docs', url: 'not a url' }, invalidUrlEnv)).resolves.toEqual({
      ok: false,
      error: 'Invalid app URL',
      url: 'not a url',
    })
    await expect(
      displayAppTool.execute({ title: 'Docs', url: 'javascript:alert(1)' }, unsupportedProtocolEnv)
    ).resolves.toEqual({
      ok: false,
      error: 'Unsupported app URL protocol',
      protocol: 'javascript:',
    })

    expect(invalidUrlEnv.getWorkspaceState().displayedApps).toEqual([])
    expect(unsupportedProtocolEnv.getWorkspaceState().displayedApps).toEqual([])
  })
})
