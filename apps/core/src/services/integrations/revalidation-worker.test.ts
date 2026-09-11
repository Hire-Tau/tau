import { expect, test } from 'bun:test'
import { IntegrationRevalidationWorker } from './revalidation-worker'

test('revalidates only bounded due candidates', async () => {
  const calls: string[] = []
  const worker = new IntegrationRevalidationWorker(
    {
      due: async (_now, limit) => {
        expect(limit).toBe(10)
        return [{ id: 'one' }]
      },
    },
    {
      validate: async (id: string) => {
        calls.push(id)
      },
    } as any
  )
  await worker.runOnce()
  expect(calls).toEqual(['one'])
})
