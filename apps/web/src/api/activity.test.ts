import { expect, mock, test } from 'bun:test'
import { getGlobalActivityPresence } from './activity'

test('getGlobalActivityPresence uses the identity-scoped aggregate endpoint', async () => {
  const paths: string[] = []
  const fetch = mock(async (path: string) => {
    paths.push(path)
    return {} as never
  })

  await getGlobalActivityPresence(fetch)

  expect(paths).toEqual(['/activity/presence'])
})
