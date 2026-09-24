import { validateThemePreference, type MyThemePreferences, type ThemePreference } from '@tau/shared'
import { CUSTOM_THEME_KEY, clearCustomTheme, loadCustomTheme, persistCustomTheme } from './custom'
import { APPEARANCE_KEY, LEGACY_THEME_KEY, THEME_ID_KEY, persistThemeSelection, type ThemeStorage } from './storage'

export const LOCAL_OVERRIDE_KEY = 'tau-theme-local-override'
const DEFAULT: ThemePreference = { themeId: 'tau', appearance: 'light', customTheme: null }
export interface ThemeSyncApi {
  getMine(signal?: AbortSignal): Promise<MyThemePreferences>
  updateMine(
    input: { expectedUserId: string; theme: ThemePreference },
    signal?: AbortSignal
  ): Promise<MyThemePreferences>
}
interface Session {
  abort: AbortController
  userId: string | null
  pending: ThemePreference | null
  writing: Promise<void> | null
  reading: Promise<void> | null
}

/** Migrate before the provider writes its default keys. Explicit false distinguishes
 * an inherited cache from a deliberate choice on older, pre-sync devices. */
export function readLocalOverride(storage: ThemeStorage | null): boolean {
  try {
    const flag = storage?.getItem(LOCAL_OVERRIDE_KEY)
    if (flag !== null && flag !== undefined) return flag === '1'
    return [THEME_ID_KEY, APPEARANCE_KEY, LEGACY_THEME_KEY, CUSTOM_THEME_KEY].some(
      (key) => storage?.getItem(key) != null
    )
  } catch {
    return false
  }
}

/** No network at construction or local paint time. Only connect() starts I/O.
 * No query cache: remote documents and queued writes belong to exactly one session. */
export class ThemeSyncStore {
  private listeners = new Set<() => void>()
  private session: Session | null = null
  private api: ThemeSyncApi | null = null
  private revision = 0
  private inheritedInSession = false
  private state: ReturnType<typeof loadCustomTheme> & { localOverride: boolean; syncAvailable: boolean }

  constructor(private storage: ThemeStorage | null) {
    const localOverride = readLocalOverride(storage)
    this.state = { ...loadCustomTheme(storage), localOverride, syncAvailable: false }
    this.persistOverride(localOverride)
    // Initial migration/defaults are persisted once. Later writes belong only
    // to deliberate changes or account adoption in apply(), never to a React
    // rerender caused by a storage event from another document.
    persistThemeSelection(storage, this.state.selection)
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private emit() {
    for (const listener of this.listeners) listener()
  }
  private persistOverride(value: boolean) {
    try {
      this.storage?.setItem(LOCAL_OVERRIDE_KEY, value ? '1' : '0')
    } catch {
      /* device-local in memory */
    }
  }
  private current(): ThemePreference {
    return { ...this.state.selection, customTheme: this.state.custom }
  }
  private apply(theme: ThemePreference) {
    clearCustomTheme(this.storage)
    const saved = !theme.customTheme || persistCustomTheme(this.storage, theme.customTheme)
    persistThemeSelection(this.storage, theme)
    this.state = {
      ...this.state,
      selection: { themeId: theme.themeId, appearance: theme.appearance },
      custom: theme.customTheme,
      error: saved ? null : 'Theme applied for this session only: device storage is unavailable.',
    }
    this.emit()
  }
  /** Called only by explicit user actions, never by OS changes or remote adoption. */
  change = (theme: ThemePreference) => {
    const result = validateThemePreference(theme)
    if (!result.ok) throw new Error(result.error)
    this.revision++
    this.persistOverride(true)
    this.state = { ...this.state, localOverride: true }
    this.apply(result.theme)
    if (this.session) {
      this.session.pending = this.current()
      void this.flush(this.session)
    }
  }
  /** Another tab's device choice must invalidate a pending server read too.
   * Read only: never echo a storage event back into network/persistence. */
  reloadFromStorage = () => {
    const loaded = loadCustomTheme(this.storage)
    const localOverride = readLocalOverride(this.storage)
    if (
      JSON.stringify([loaded.selection, loaded.custom, localOverride]) ===
      JSON.stringify([this.state.selection, this.state.custom, this.state.localOverride])
    )
      return
    this.revision++
    if (this.session) this.session.pending = null
    this.state = { ...this.state, ...loaded, localOverride }
    this.emit()
  }
  recoverCustom = () => {
    clearCustomTheme(this.storage)
    this.state = { ...this.state, custom: null, error: 'Custom theme could not be applied. Restored its base theme.' }
    this.emit()
  }
  connect = (api: ThemeSyncApi) => {
    this.disconnect()
    this.api = api
    this.session = { abort: new AbortController(), userId: null, pending: null, writing: null, reading: null }
    void this.refresh()
  }
  disconnect = (clearInherited = false) => {
    this.session?.abort.abort()
    this.session = null
    this.api = null
    this.state = { ...this.state, syncAvailable: false }
    if (clearInherited && this.inheritedInSession && !this.state.localOverride) this.apply(DEFAULT)
    if (clearInherited) this.inheritedInSession = false
    this.emit()
  }
  private alive(session: Session) {
    return this.session === session && !session.abort.signal.aborted
  }
  private async flush(session: Session): Promise<void> {
    if (!this.alive(session) || !session.userId || !session.pending || session.writing)
      return session.writing ?? undefined
    const api = this.api!
    session.writing = (async () => {
      while (this.alive(session) && session.pending) {
        const theme = session.pending
        const revision = this.revision
        session.pending = null
        try {
          await api.updateMine({ expectedUserId: session.userId!, theme }, session.abort.signal)
        } catch {
          // Keep only the latest unsent choice, within this session. Reconnect/focus
          // retries it; neither login nor reload uploads an old device/account cache.
          // Storage replacement/adoption cancels the original intent even when
          // the replacement is itself an override. Never resurrect that old PUT;
          // a newer same-tab choice is already in pending and stays there.
          if (this.alive(session) && this.state.localOverride && revision === this.revision) session.pending ??= theme
          break
        }
      }
    })()
    await session.writing
    session.writing = null
  }
  refresh = async (): Promise<void> => {
    const session = this.session
    if (!session || session.reading) return session?.reading ?? undefined
    const api = this.api!
    session.reading = (async () => {
      try {
        await this.flush(session)
        if (!this.alive(session)) return
        const revision = this.revision
        const result = await api.getMine(session.abort.signal)
        if (!this.alive(session)) return
        if (!result || typeof result.userId !== 'string' || !result.userId) return
        if (session.userId && session.userId !== result.userId) {
          // Cookie changed outside the UI. Never carry a pending write or document
          // into that identity. A new authenticated session must reconnect.
          this.disconnect(true)
          return
        }
        const parsed =
          result.theme === null ? { ok: true as const, theme: DEFAULT } : validateThemePreference(result.theme)
        if (!parsed.ok) return
        session.userId = result.userId
        this.state = { ...this.state, syncAvailable: true }
        if (!this.state.localOverride && revision === this.revision) {
          this.inheritedInSession = true
          this.apply(parsed.theme)
        } else this.emit()
        await this.flush(session)
      } catch {
        /* offline/old server: silently remain device-local */
      }
    })()
    await session.reading
    session.reading = null
  }
  adoptSynced = () => {
    if (!this.session) return
    this.revision++
    this.persistOverride(false)
    this.state = { ...this.state, localOverride: false }
    this.session.pending = null
    this.emit()
    // A read already in flight was captured before the action. Await it, then
    // reread after any outstanding writes; never apply a cached remote snapshot.
    const session = this.session
    void (async () => {
      await session.reading
      if (this.alive(session) && !this.state.localOverride) await this.refresh()
    })()
  }
}
