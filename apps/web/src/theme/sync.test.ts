import { expect, test } from 'bun:test'
import { SYNC_THEME_DESCRIPTORS, type MyThemePreferences, type ThemePreference } from '@tau/shared'
import { ThemeSyncStore, LOCAL_OVERRIDE_KEY, type ThemeSyncApi } from './sync'
import { BUILT_IN_THEMES } from './registry'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v)
    },
    removeItem: (k: string) => {
      values.delete(k)
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const harbor: ThemePreference = { themeId: 'harbor', appearance: 'dark', customTheme: null }
const ember: ThemePreference = { themeId: 'ember', appearance: 'system', customTheme: null }
function server(theme: ThemePreference | null = harbor) {
  let remote = theme
  const writes: Array<{ expectedUserId: string; theme: ThemePreference }> = []
  const api: ThemeSyncApi = {
    getMine: async () => ({ userId: 'A', theme: remote }),
    updateMine: async (input) => {
      writes.push(input)
      remote = input.theme
      return { userId: 'A', theme: remote }
    },
  }
  return {
    api,
    writes,
    set: (t: ThemePreference) => {
      remote = t
    },
  }
}

test('sync metadata matches every web builtin (no duplicated palette)', () => {
  expect(SYNC_THEME_DESCRIPTORS).toEqual(BUILT_IN_THEMES.map(({ id, label, kind }) => ({ id, label, kind })))
})
test('fresh device adopts; reload retains non-override cache; adoption never echoes a write', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const remote = server()
  expect(store.getSnapshot().localOverride).toBe(false)
  expect(local.getItem(LOCAL_OVERRIDE_KEY)).toBe('0')
  store.connect(remote.api)
  await store.refresh()
  expect(store.getSnapshot().selection).toEqual({ themeId: 'harbor', appearance: 'dark' })
  expect(remote.writes).toHaveLength(0)
  const reloaded = new ThemeSyncStore(local)
  expect(reloaded.getSnapshot().localOverride).toBe(false)
  reloaded.connect(remote.api)
  await reloaded.refresh()
  expect(reloaded.getSnapshot().selection).toEqual(store.getSnapshot().selection)
  expect(remote.writes).toHaveLength(0)
  store.disconnect()
  reloaded.disconnect()
})
test.each(['tau-theme', 'tau-theme-id', 'tau-appearance'])(
  'pre-sync %s is a local override, not uploaded on login',
  async (key) => {
    const store = new ThemeSyncStore(storage({ [key]: key === 'tau-theme-id' ? 'ember' : 'dark' }))
    const before = store.getSnapshot().selection
    const remote = server()
    store.connect(remote.api)
    await store.refresh()
    expect(store.getSnapshot().selection).toEqual(before)
    expect(store.getSnapshot().localOverride).toBe(true)
    expect(remote.writes).toHaveLength(0)
    store.disconnect()
  }
)
test('local edit wins over pending initial read, pushes once; clear override rereads then follows account', async () => {
  const response = deferred<MyThemePreferences>()
  const readStarted = deferred<void>()
  const remote = server()
  const store = new ThemeSyncStore(storage())
  store.connect({
    ...remote.api,
    getMine: () => {
      readStarted.resolve()
      return response.promise
    },
  })
  await readStarted.promise
  store.change(ember)
  response.resolve({ userId: 'A', theme: harbor })
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(remote.writes).toEqual([{ expectedUserId: 'A', theme: ember }])
  store.disconnect()
  store.connect(remote.api)
  await store.refresh()
  remote.set(harbor)
  store.adoptSynced()
  await store.refresh()
  expect(store.getSnapshot().localOverride).toBe(false)
  expect(store.getSnapshot().selection.themeId).toBe('harbor')
  remote.set(ember)
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(remote.writes).toHaveLength(1)
  store.disconnect()
})
test('stale old-account read after logout/relogin cannot apply or seed a new-account write', async () => {
  const response = deferred<MyThemePreferences>()
  const started = deferred<void>()
  const store = new ThemeSyncStore(storage())
  const old = server()
  store.connect({
    ...old.api,
    getMine: () => {
      started.resolve()
      return response.promise
    },
  })
  await started.promise
  const pending = store.refresh()
  store.change(ember)
  store.disconnect(true)
  const next = server(null)
  store.connect({ ...next.api, getMine: async () => ({ userId: 'B', theme: null }) })
  await store.refresh()
  response.resolve({ userId: 'A', theme: harbor })
  await pending
  expect(store.getSnapshot().selection.themeId).toBe('ember') // deliberate device choice retained
  expect(old.writes).toHaveLength(0)
  expect(next.writes).toHaveLength(0)
  store.disconnect()
})
test('logout clears inherited custom preference; next empty account does not receive it', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const remote = server({
    ...harbor,
    customTheme: {
      format: 'tau-custom-theme',
      version: 1,
      name: 'Private palette',
      base: 'harbor',
      appearance: 'dark',
      overrides: { '--term-bg': '#123456' },
    },
  })
  store.connect(remote.api)
  await store.refresh()
  expect(store.getSnapshot().custom?.name).toBe('Private palette')
  store.disconnect() // React cleanup, followed by the new identity boundary
  store.disconnect(true)
  expect(store.getSnapshot().custom).toBeNull()
  expect(store.getSnapshot().syncAvailable).toBe(false)
  expect(local.getItem('tau-custom-theme')).toBeNull()
  const next = server(null)
  store.connect(next.api)
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('tau')
  expect(next.writes).toHaveLength(0)
  store.disconnect()
})
test('serialized writes coalesce to latest choice; failed writes retry only within their original session', async () => {
  const first = deferred<MyThemePreferences>()
  const remote = server()
  const writes: ThemePreference[] = []
  const store = new ThemeSyncStore(storage())
  store.connect({
    ...remote.api,
    updateMine: async ({ theme }) => {
      writes.push(theme)
      if (writes.length === 1) return first.promise
      return { userId: 'A', theme }
    },
  })
  await store.refresh()
  store.change(ember)
  store.change(harbor)
  store.change({ ...ember, appearance: 'light' })
  expect(writes).toHaveLength(1)
  first.reject(new Error('offline'))
  await store.refresh()
  await store.refresh()
  expect(writes.at(-1)?.appearance).toBe('light')
  expect(writes.some((t) => t === harbor)).toBe(false)
  store.disconnect(true)
  const next = server()
  store.connect(next.api)
  await store.refresh()
  expect(next.writes).toHaveLength(0)
  store.disconnect()
})
test('adopt while write in flight rereads after it; a newer deliberate edit cancels adoption', async () => {
  const write = deferred<MyThemePreferences>()
  const remote = server()
  const store = new ThemeSyncStore(storage())
  store.connect({
    ...remote.api,
    updateMine: async (input) => {
      await write.promise
      return remote.api.updateMine(input)
    },
  })
  await store.refresh()
  store.change(ember)
  store.adoptSynced()
  store.change(harbor)
  write.resolve({ userId: 'A', theme: ember })
  await store.refresh()
  expect(store.getSnapshot().localOverride).toBe(true)
  expect(store.getSnapshot().selection.themeId).toBe('harbor')
  expect(remote.writes.at(-1)?.theme).toEqual(harbor)
  store.disconnect()
})
test('invalid/oversized remote values and network failures leave local state intact; reconnect adopts once', async () => {
  const store = new ThemeSyncStore(storage())
  const before = store.getSnapshot().selection
  for (const bad of [
    { ...harbor, themeId: 'unknown' },
    { ...harbor, customTheme: { overrides: { '--term-bg': 'url(x)' } } },
  ]) {
    store.connect({
      getMine: async () => ({ userId: 'A', theme: bad }) as MyThemePreferences,
      updateMine: async () => {
        throw new Error('must not write')
      },
    })
    await store.refresh()
    expect(store.getSnapshot().selection).toEqual(before)
  }
  let online = false
  store.connect({
    ...server().api,
    getMine: async () => {
      if (!online) throw new Error('offline')
      return { userId: 'A', theme: harbor }
    },
  })
  await store.refresh()
  expect(store.getSnapshot().selection).toEqual(before)
  online = true
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('harbor')
  store.disconnect()
})
test('cookie identity change during reconnect discards cached preference and queued updates', async () => {
  const store = new ThemeSyncStore(storage())
  let userId = 'A'
  const remote = server()
  store.connect({ ...remote.api, getMine: async () => ({ userId, theme: harbor }) })
  await store.refresh()
  userId = 'B'
  await store.refresh()
  expect(store.getSnapshot().syncAvailable).toBe(false)
  expect(store.getSnapshot().selection.themeId).toBe('tau')
  store.change(ember)
  expect(remote.writes).toHaveLength(0)
})
test('storage denial remains functional in memory and unauthenticated edits never need an API', () => {
  const store = new ThemeSyncStore({
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
    removeItem() {
      throw new Error('denied')
    },
  })
  store.change(ember)
  expect(store.getSnapshot().localOverride).toBe(true)
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(store.getSnapshot().syncAvailable).toBe(false)
})

test('another tab setting a device override invalidates slow reads without echo writes', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const response = deferred<MyThemePreferences>()
  const started = deferred<void>()
  const remote = server()
  store.connect({
    ...remote.api,
    getMine: () => {
      started.resolve()
      return response.promise
    },
  })
  await started.promise
  local.setItem(LOCAL_OVERRIDE_KEY, '1')
  local.setItem('tau-theme-id', 'ember')
  local.setItem('tau-appearance', 'light')
  store.reloadFromStorage()
  response.resolve({ userId: 'A', theme: harbor })
  await store.refresh()
  expect(store.getSnapshot().selection.themeId).toBe('ember')
  expect(store.getSnapshot().localOverride).toBe(true)
  expect(remote.writes).toHaveLength(0)
  store.disconnect()
})

test('failed in-flight PUT cannot resurrect a write invalidated by a newer storage choice', async () => {
  const local = storage()
  const store = new ThemeSyncStore(local)
  const failed = deferred<MyThemePreferences>()
  const remote = server()
  const writes: ThemePreference[] = []
  store.connect({
    ...remote.api,
    updateMine: async (input) => {
      writes.push(input.theme)
      if (writes.length === 1) return failed.promise
      return remote.api.updateMine(input)
    },
  })
  await store.refresh()
  store.change(ember)
  expect(writes).toEqual([ember])

  // Another tab has published Harbor and persisted its deliberate device choice.
  remote.set(harbor)
  local.setItem(LOCAL_OVERRIDE_KEY, '1')
  local.setItem('tau-theme-id', 'harbor')
  local.setItem('tau-appearance', 'dark')
  store.reloadFromStorage()
  const refresh = store.refresh()
  failed.reject(new Error('old Ember request failed'))
  await refresh
  await store.refresh()

  expect(writes).toEqual([ember])
  expect(store.getSnapshot().selection).toEqual({ themeId: 'harbor', appearance: 'dark' })
  expect(store.getSnapshot().localOverride).toBe(true)
  expect((await remote.api.getMine()).theme).toEqual(harbor)
  store.disconnect()
})

test('failed in-flight PUT retries on reconnect when the deliberate intent is still current', async () => {
  const store = new ThemeSyncStore(storage())
  const failed = deferred<MyThemePreferences>()
  const remote = server()
  const writes: ThemePreference[] = []
  store.connect({
    ...remote.api,
    updateMine: async (input) => {
      writes.push(input.theme)
      if (writes.length === 1) return failed.promise
      return remote.api.updateMine(input)
    },
  })
  await store.refresh()
  store.change(ember)
  const reconnect = store.refresh()
  failed.reject(new Error('connection dropped'))
  await reconnect
  expect(writes).toEqual([ember, ember])
  expect((await remote.api.getMine()).theme).toEqual(ember)
  expect(store.getSnapshot().selection).toEqual({ themeId: 'ember', appearance: 'system' })
  store.disconnect()
})
