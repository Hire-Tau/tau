let nextOwner = Promise.resolve()

/** Acquires exclusive ownership of process-global DOM descriptors. The returned release is idempotent. */
export async function acquireDomOwnershipLease(): Promise<() => void> {
  const previous = nextOwner
  let releaseNext!: () => void
  nextOwner = new Promise<void>((resolve) => {
    releaseNext = resolve
  })
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    releaseNext()
  }
}

export async function withDomOwnership<T>(body: () => Promise<T>): Promise<T> {
  const release = await acquireDomOwnershipLease()
  try {
    return await body()
  } finally {
    release()
  }
}
