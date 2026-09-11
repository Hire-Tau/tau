import { describe, expect, mock, test } from 'bun:test'
import { listRecommendations, RecommendationsApiError, updateRecommendationStatus } from './recommendations'
const apiFetchMock = mock(async () => ({ items: [], nextCursor: null }))
const authFetchMock = mock(async () => Response.json({ items: [], nextCursor: null }))
describe('recommendations API client', () => {
  test('includes lifecycle, squad, limit, and cursor filters', async () => {
    authFetchMock.mockClear()
    await listRecommendations(
      { status: 'open', squadId: 'squad-1', limit: 50, cursor: 'opaque' },
      { authFetch: authFetchMock }
    )
    expect(authFetchMock.mock.calls[0][0]).toBe('/recommendations?status=open&squadId=squad-1&limit=50&cursor=opaque')
  })

  test('preserves cursor reset status and code', async () => {
    authFetchMock.mockResolvedValueOnce(
      Response.json(
        { error: 'Recommendation access changed', code: 'RECOMMENDATIONS_CURSOR_RESET_REQUIRED' },
        { status: 409 }
      )
    )
    const error = await listRecommendations({}, { authFetch: authFetchMock }).catch((value) => value)
    expect(error).toBeInstanceOf(RecommendationsApiError)
    expect(error.status).toBe(409)
    expect(error.code).toBe('RECOMMENDATIONS_CURSOR_RESET_REQUIRED')
  })

  test('sends status-only lifecycle updates', async () => {
    apiFetchMock.mockClear()
    await updateRecommendationStatus('r1', 'resolved', apiFetchMock)
    expect(apiFetchMock.mock.calls[0]).toEqual([
      '/recommendations/r1/status',
      { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) },
    ])
  })
})
