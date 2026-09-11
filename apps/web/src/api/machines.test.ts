import { describe, expect, mock, test } from 'bun:test'

const apiFetchMock = mock(async () => ({ moved: false, reason: 'active-turn' }))
import { migrateBox } from './machines'

describe('machines API client', () => {
  test('ordinary web migration sends only the sandbox identity and never synthesizes force', async () => {
    apiFetchMock.mockClear()

    await migrateBox('target-machine', 'squad-123', apiFetchMock)

    expect(apiFetchMock.mock.calls[0]).toEqual([
      '/machines/target-machine/migrate-box',
      {
        method: 'POST',
        body: JSON.stringify({ sandboxId: 'squad-123' }),
      },
    ])
    expect(JSON.parse(apiFetchMock.mock.calls[0][1].body)).not.toHaveProperty('force')
  })
})
