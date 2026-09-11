/** Rotate clients without interrupting speech requests already using the old credential. */
export function createSpeechClientPool<T extends { close(): Promise<void> }>(dependencies: {
  credential: () => string | undefined
  create: (credential: string | undefined) => T
}) {
  type Entry = { credential: string | undefined; client: T; users: number; retired: boolean }
  let current: Entry | undefined
  async function closeIfUnused(entry: Entry) {
    if (entry.retired && entry.users === 0) await entry.client.close().catch(() => {})
  }
  return {
    async acquire() {
      const credential = dependencies.credential()
      let previous: Entry | undefined
      if (!current || credential !== current.credential) {
        const next = { credential, client: dependencies.create(credential), users: 0, retired: false }
        previous = current
        current = next
        if (previous) {
          previous.retired = true
        }
      }
      const entry = current
      entry.users++
      if (previous) await closeIfUnused(previous)
      let released = false
      return {
        client: entry.client,
        async release() {
          if (released) return
          released = true
          entry.users--
          await closeIfUnused(entry)
        },
      }
    },
    async retire() {
      const previous = current
      current = undefined
      if (previous) {
        previous.retired = true
        await closeIfUnused(previous)
      }
    },
  }
}
