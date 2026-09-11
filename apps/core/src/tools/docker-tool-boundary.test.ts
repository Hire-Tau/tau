import { expect, spyOn, test } from 'bun:test'
import { writeDockerFile } from './docker-tool-boundary'

test('writes only through the verified stdin execution boundary', async () => {
  const manager = {
    execWithStdin: async () => Buffer.alloc(0),
    exec: () => {
      throw new Error('direct exec must not receive file contents')
    },
  }
  const stdin = spyOn(manager, 'execWithStdin')
  await writeDockerFile(manager, 'sandbox', '/workspace/file', 'secret body')
  expect(stdin).toHaveBeenCalledWith('sandbox', ['tee', '/workspace/file'], Buffer.from('secret body'))
})
