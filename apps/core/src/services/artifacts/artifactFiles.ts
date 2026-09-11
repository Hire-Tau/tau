import { constants as fsConstants } from 'fs'
import { open } from 'fs/promises'

export async function readUtf8RegularFileNoFollowBounded(resolvedPath: string, maxBytes: number): Promise<string> {
  const readOnlyNoFollowFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  const handle = await open(resolvedPath, readOnlyNoFollowFlags)
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) {
      throw new Error('artifact entry is not a regular file')
    }

    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0)
    if (bytesRead > maxBytes) {
      throw new Error(`file size exceeds ${maxBytes} bytes`)
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
