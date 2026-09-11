let flockPromise: Promise<(fd: number, operation: number) => number> | undefined

/** Non-blocking kernel advisory flock. Ownership is tied to the open fd. */
export async function advisoryLock(fd: number, operation: 'lock' | 'unlock'): Promise<boolean> {
  flockPromise ??= import('bun:ffi').then(({ dlopen, FFIType }) => {
    const library = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    return (lockFd: number, lockOperation: number) => library.symbols.flock(lockFd, lockOperation)
  })
  const flock = await flockPromise
  return flock(fd, operation === 'lock' ? 2 | 4 : 8) === 0
}
